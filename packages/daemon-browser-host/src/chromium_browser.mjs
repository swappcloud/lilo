import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTransientBrowserTransition } from "./browser_transition.mjs";
import { safeDiagnostic } from "./diagnostics.mjs";

const driver = await readFile(new URL("../../phone-login/driver.js", import.meta.url), "utf8");
const observer = await readFile(new URL("../../phone-login/observer.js", import.meta.url), "utf8");
const bootstrap = `window.__liloPhoneProgress={step:"working"};window.__liloPhoneReport=r=>{if(r.attempt===window.__liloPhoneAttempt&&["working","ask","challenge","error"].includes(r.step))window.__liloPhoneProgress={step:r.step,ask:r.ask,message:typeof r.message==="string"?r.message.slice(0,240):""}};`;

/** A regular Chromium process on a private display, using the desktop form driver. */
export class ChromiumBrowser {
  constructor(dataDir) { this.dataDir = dataDir; this.diagnostic = {}; }
  status() { return { engine: "chromium", running: !!this.child, diagnostic: this.diagnostic }; }
  async start(provider, options = {}) {
    if (process.platform !== "linux") throw new Error("Daemon Chromium login requires Linux.");
    // Keep the optional browser automation runtime out of the idle host.
    const { chromium } = await import("playwright-core");
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700);
    this.mode = options.mode === "voice" ? "voice" : "login";
    this.profile = await mkdtemp(join(this.dataDir, `${this.mode}-`));
    this.provider = provider;
    this.attempt = 1;
    this.answer = null;
    this.diagnostic = {};
    if (this.mode === "voice") { this.voiceStage = "browser"; this.voiceDiagnostic = null; }
    // CDP is restricted to loopback inside this unprivileged container.
    // User namespaces provide the sandbox; the setuid helper needs elevated caps.
    this.cdpPort = await availablePort();
    const browserArgs = ["--disable-setuid-sandbox", `--remote-debugging-port=${this.cdpPort}`, "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${this.profile}`, "--window-size=520,760", "--no-first-run", "--no-default-browser-check",
      ...(this.mode === "voice" ? ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] : []), "about:blank"];
    this.child = spawn("xvfb-run", ["-a", "-s", "-screen 0 1280x900x24 -nolisten tcp", "chromium", ...browserArgs], {
      stdio: ["ignore", "ignore", "pipe"], detached: true,
    });
    this.failure = null;
    this.child.on("error", () => { this.failure = "engine-unavailable"; });
    this.child.stderr.on("data", chunk => {
      if (/No usable sandbox|Operation not permitted/.test(chunk.toString("utf8"))) this.failure = "sandbox-unavailable";
    });
    try {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (this.failure || this.child.exitCode !== null) throw new Error("Chromium initialization failed.");
        try {
          const response = await fetch(`http://127.0.0.1:${this.cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) break;
        } catch { /* Wait for the normal browser's private CDP listener. */ }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`, { timeout: 5000 });
      this.context = this.browser.contexts()[0];
      if (!this.context) throw new Error("Chromium did not create a browser context.");
      this.page = this.context.pages()[0] ?? await this.context.newPage();
      await this.page.setViewportSize({ width: 430, height: 740 });
      const allowed = new Set(provider.navigationHosts);
      await this.context.route("**/*", async route => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame().parentFrame() === null) {
          const url = new URL(request.url());
          if (url.protocol !== "https:" || !allowed.has(url.hostname)) return route.abort();
        }
        return route.continue();
      });
      this.context.on("page", page => { void page.close(); });
      await this.context.addInitScript(observer);
      await this.context.addInitScript(bootstrap);
      this.context.on("response", response => {
        const category = provider.responseCategory?.(response.url(), response.request().method());
        if (category) {
          this.diagnostic[`${category}Status`] = response.status();
          if (this.mode === "voice") console.info(JSON.stringify({ event: "voice-response", category, status: response.status() }));
          else if (!new Set(["session", "voice"]).has(category)) console.info(JSON.stringify({ event: "phone-response", category, status: response.status() }));
        }
      });
      await this.page.bringToFront();
      if (this.mode === "voice") {
        this.voiceStage = "browser";
        if (!provider.voice) throw new Error("Provider voice is unavailable.");
        const account = options.account;
        if (typeof account?.accessToken !== "string" || !account.accessToken || typeof account.sessionCookie !== "string" || !account.sessionCookie) throw new Error("A signed-in ChatGPT account is required.");
        this.voiceStage = "session";
        await this.#restoreCookies(account.sessionCookie, provider.homeUrl);
        this.voiceStage = "microphone";
        await this.context.grantPermissions(["microphone"], { origin: provider.capture.origin });
        this.voiceStage = "browser";
        const bundle = voiceBundlePath();
        await this.page.addInitScript({ path: bundle });
        this.voiceStage = "browser";
        await this.page.goto(provider.homeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await this.page.evaluate(deviceId => { window.__liloDeviceId = deviceId; }, typeof account.deviceId === "string" ? account.deviceId : "");
        this.voiceStage = "browser";
      } else {
        await this.page.goto(provider.loginUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      }
    } catch (error) {
      if (this.mode === "voice") {
        this.voiceDiagnostic = browserFailureDiagnostic(error, this.voiceStage);
        await this.close();
        throw new Error("Voice browser initialization failed.");
      }
      await this.close();
      throw error;
    }
  }
  async #restoreCookies(header, url) {
    await this.context.addCookies(parseSessionCookies(header, url));
  }
  async voiceAction(action, payload = {}) {
    if (this.mode !== "voice" || !this.page) throw new Error("Voice browser is unavailable.");
    try {
      const result = await this.page.evaluate(async ({ action: name, payload: data }) => {
        const voice = window.__liloVoice;
        if (!voice) throw new Error("Voice transport is unavailable.");
        if (name === "start") return voice.start(data.options);
        if (name === "status") return voice.snapshot(data.after ?? 0);
        if (name === "diagnostics") return voice.diagnostics();
        if (name === "transportDiagnostics") return voice.transportDiagnostics();
        if (name === "stop") return voice.stop();
        if (name === "mute") return voice.setMuted(Boolean(data.muted));
        if (name === "interrupt") return voice.interrupt();
        if (name === "text") return voice.text(data.text, data.hidden === true);
        throw new Error("Unsupported voice action.");
      }, { action, payload });
      if (action === "start") this.voiceStage = "connected";
      return result;
    } catch (error) {
      this.voiceDiagnostic = parseVoiceDiagnostic(error?.message) ?? browserFailureDiagnostic(error, this.voiceStage ?? "browser");
      throw new Error("Voice browser action failed.");
    }
  }
  voiceDiagnostics() { return this.voiceDiagnostic ? { ...this.voiceDiagnostic } : null; }
  async drive(field = null, value = "", submitting = false) {
    const form = this.provider.phoneForm;
    const values = { __FIELD__: field, __VALUE__: value, __ATTEMPT__: this.attempt, __ENTRY__: form.entry, __ENTRY_TEXT__: form.entryText, __CODE_SWITCH__: form.codeSwitch, __PHONE_SWITCH__: form.phoneSwitch, __CODE_INPUTS__: form.codeInputs };
    const script = driver.replace(/__FIELD__|__VALUE__|__ATTEMPT__|__ENTRY__|__ENTRY_TEXT__|__CODE_SWITCH__|__PHONE_SWITCH__|__CODE_INPUTS__/g, token => JSON.stringify(values[token]));
    await this.page.evaluate(`${submitting ? 'window.__liloPhoneProgress={step:"working"};' : ""}${script}`);
  }
  async input(message) {
    try {
      switch (message.action) {
        case "answer":
          if (!["email", "password", "code", "phone"].includes(message.field) || typeof message.value !== "string" || !message.value || message.value.length > 4096) throw new Error("Invalid answer.");
          this.attempt++;
          this.answer = { field: message.field, value: message.value, deadline: Date.now() + 45000 };
          await this.drive(message.field, message.value, true);
          break;
        case "click":
          if (!Number.isFinite(message.x) || !Number.isFinite(message.y) || message.x < 0 || message.x > 430 || message.y < 0 || message.y > 740) throw new Error("Invalid position.");
          const viewport = await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
          await this.page.mouse.click(message.x * viewport.width / 430, message.y * viewport.height / 740);
          break;
        case "frame": case "visual": break;
        default: throw new Error("Unsupported browser action.");
      }
    } catch (error) {
      if (!isTransientBrowserTransition(error)) throw error;
    }
  }
  async snapshot() {
    try {
      return await this.#snapshot();
    } catch (error) {
      if (!isTransientBrowserTransition(error)) throw error;
      const answer = this.answer;
      if (answer && Date.now() > answer.deadline) {
        this.answer = null;
        return { frame: { phase: "login", step: "error", ask: answer.field, message: "The sign-in page did not answer. Please try again." }, account: null };
      }
      return { frame: { phase: "login", step: "working" }, account: null };
    }
  }
  async #snapshot() {
    const url = new URL(this.page.url());
    let account = null;
    if (url.origin === this.provider.capture.origin) {
      const captured = await this.page.evaluate(this.provider.capture.script);
      let session;
      try { session = JSON.parse(captured); } catch { session = null; }
      if (typeof session?.accessToken === "string" && session.accessToken && session.accessToken.length <= 32768 && typeof session.user?.email === "string" && session.user.email.trim() && session.user.email.length <= 320) {
        const cookies = await this.context.cookies(this.provider.homeUrl);
        const pattern = new RegExp(`^${this.provider.capture.cookiePattern}$`);
        const sessionCookie = cookies.filter(cookie => pattern.test(cookie.name)).sort((a, b) => a.name.localeCompare(b.name)).map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
        account = { provider: this.provider.id, session, sessionCookie };
      }
    }
    if (account) return { frame: { phase: "connected", origin: url.origin }, account };
    let progress = await this.page.evaluate(() => window.__liloPhoneProgress ?? { step: "working" });
    if (progress.step !== "error" && url.protocol === "https:" && this.provider.navigationHosts.includes(url.hostname)) {
      await this.drive(this.answer?.field, this.answer?.value);
      progress = await this.page.evaluate(() => window.__liloPhoneProgress ?? { step: "working" });
    }
    if (this.answer) {
      if (["ask", "error"].includes(progress.step)) this.answer = null;
      else if (progress.step === "challenge") this.answer.deadline = Date.now() + 45000;
      else if (Date.now() > this.answer.deadline) {
        progress = { step: "error", ask: this.answer.field, message: "The sign-in page did not answer. Please try again." };
        this.answer = null;
        await this.page.evaluate(value => { window.__liloPhoneProgress = value; }, progress);
      }
    }
    const diagnostic = await this.page.evaluate(() => {
      const s = window.__liloPhoneObserver ?? {};
      const d = window.__liloPhoneDiagnostic ?? "";
      return { state: document.readyState, focused: document.hasFocus(), hidden: document.hidden, ...s, submitReached: /:submit(?: |$)/.test(d), buttonDisabled: d.includes("disabled=true"), inputChanged: d.includes("submit-input-changed"), browserEdit: d.includes("edit=browser") };
    });
    this.diagnostic = { ...this.diagnostic, ...safeDiagnostic(diagnostic) };
    console.info(JSON.stringify({ event: "phone-form", ...this.diagnostic }));
    const frame = { phase: "login", origin: url.origin, ...progress };
    if (progress.step === "challenge") {
      const buffer = await this.page.screenshot({ type: "jpeg", quality: 55, timeout: 5000 });
      if (buffer.length > 300000) throw new Error("Challenge frame is too large.");
      Object.assign(frame, { image: buffer.toString("base64"), width: 430, height: 740 });
    }
    return { frame, account: null };
  }
  async close() {
    this.answer = null;
    await this.browser?.close().catch(() => {});
    if (this.child?.pid) { try { process.kill(-this.child.pid, "SIGKILL"); } catch {} }
    this.child = this.browser = this.context = this.page = null;
    if (this.profile) await rm(this.profile, { recursive: true, force: true });
    this.profile = null;
    this.cdpPort = null;
    this.mode = null;
  }
}

export function parseSessionCookies(header, url) {
  const cookies = header.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const split = part.indexOf("=");
    if (split < 1) throw new Error("Invalid account cookie.");
    return { name: part.slice(0, split), value: part.slice(split + 1), url, secure: true, httpOnly: true, sameSite: "Lax" };
  });
  if (!cookies.length || cookies.length > 8 || cookies.some(cookie => !/^(?:__Secure-)?(?:next-auth|authjs)\.session-token(?:\.\d+)?$/.test(cookie.name))) throw new Error("Invalid account cookie.");
  return cookies;
}

export function voiceBundlePath(override = process.env.LILO_VOICE_BUNDLE) {
  return override ?? fileURLToPath(new URL("../voice.js", import.meta.url));
}

function parseVoiceDiagnostic(message) {
  if (typeof message !== "string") return null;
  const match = message.match(/LILO_VOICE\|(browser|session|microphone|offer|ice|provider-answer|connected)\|([a-z-]+)(?:\|(\d{3}))?/);
  if (!match) return null;
  const categories = new Set(["audio-permission", "audio-device-missing", "timeout", "network", "provider-response", "expired-session", "invalid-answer", "offer-failed", "navigation", "connection-lost", "browser-failure", "unknown"]);
  if (!categories.has(match[2])) return null;
  const status = match[3] ? Number(match[3]) : undefined;
  return { stage: match[1], category: match[2], ...(status && status >= 100 && status <= 599 ? { status } : {}) };
}

function browserFailureDiagnostic(error, stage) {
  const message = typeof error?.message === "string" ? error.message : "";
  const domPermission = /NotAllowedError|PermissionDeniedError|SecurityError|permission denied/i.test(message);
  const domDevice = /NotFoundError|DevicesNotFoundError|OverconstrainedError|NotReadableError/i.test(message);
  const normalizedStage = domPermission || domDevice ? "microphone" : ["session", "microphone"].includes(stage) ? stage : "browser";
  let category = "browser-failure";
  if (/Execution context was destroyed|Cannot find context with specified id|navigation/i.test(message)) category = "navigation";
  else if (/timeout|timed out/i.test(message)) category = "timeout";
  else if (/net::ERR_|fetch failed|network/i.test(message)) category = "network";
  else if (domPermission || (stage === "microphone" && /permission|denied|not allowed/i.test(message))) category = "audio-permission";
  else if (domDevice || (stage === "microphone" && /device|audio|not readable/i.test(message))) category = "audio-device-missing";
  else if (/Invalid account cookie|sign-in|signed-in/i.test(message)) category = "expired-session";
  return { stage: normalizedStage, category };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
