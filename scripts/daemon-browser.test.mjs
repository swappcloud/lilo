import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { seal, open, ReplayGuard } from "../packages/daemon-browser-host/src/crypto.mjs";
import { BrowserService } from "../packages/daemon-browser-host/src/service.mjs";
import { NativeBrowser } from "../packages/daemon-browser-host/src/browser.mjs";
import { ChromiumBrowser, voiceBundlePath } from "../packages/daemon-browser-host/src/chromium_browser.mjs";
import { fileURLToPath } from "node:url";
import { isTransientBrowserTransition } from "../packages/daemon-browser-host/src/browser_transition.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { safeDiagnostic } from "../packages/daemon-browser-host/src/diagnostics.mjs";

const navigationLoss = () => new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation.");

test("voice initialization resolves its bundled transport without an environment override", () => {
  assert.equal(voiceBundlePath(null), fileURLToPath(new URL("../packages/daemon-browser-host/voice.js", import.meta.url)));
  assert.equal(voiceBundlePath("custom-voice.js"), "custom-voice.js");
});

function chromiumFixture({ url = "https://auth.openai.com/login", evaluate, cookies = [] } = {}) {
  const browser = new ChromiumBrowser("unused");
  browser.provider = {
    id: "chatgpt-web",
    phoneForm: { entry: "", entryText: "", codeSwitch: "", phoneSwitch: "", codeInputs: "" },
    navigationHosts: ["auth.openai.com", "chatgpt.com"],
    capture: {
      origin: "https://chatgpt.com",
      script: "capture-session",
      cookiePattern: "session-token",
    },
  };
  browser.attempt = 1;
  browser.diagnostic = {};
  browser.page = {
    url: () => url,
    evaluate,
    screenshot: async () => Buffer.from("fixture"),
  };
  browser.context = { cookies: async () => cookies };
  let closes = 0;
  browser.close = async () => { closes++; };
  return { browser, closeCount: () => closes };
}

test("Chromium keeps an OTP answer across a navigation context loss until the next question", async () => {
  let calls = 0;
  let progress = { step: "working" };
  const { browser, closeCount } = chromiumFixture({
    evaluate: async script => {
      calls++;
      if (calls === 1) throw navigationLoss(); // answer's injected driver
      if (typeof script === "string") return undefined;
      if (script.toString().includes("__liloPhoneProgress")) return progress;
      return {};
    },
  });

  await browser.input({ action: "answer", field: "code", value: "private-otp" });
  const attempt = browser.attempt;
  const answer = browser.answer;
  const deadline = answer.deadline;
  assert.equal(attempt, 2);
  assert.equal(answer.value, "private-otp");

  const waiting = await browser.snapshot();
  assert.deepEqual(waiting.frame, { phase: "login", origin: "https://auth.openai.com", step: "working" });
  assert.equal(browser.answer, answer);
  assert.equal(answer.deadline, deadline);
  assert.equal(closeCount(), 0);

  progress = { step: "ask", ask: "code" };
  const next = await browser.snapshot();
  assert.equal(next.frame.step, "ask");
  assert.equal(next.frame.ask, "code");
  assert.equal(JSON.stringify(next.frame).includes("private-otp"), false);
  assert.equal(browser.answer, null);
  assert.equal(closeCount(), 0);
});

test("Chromium retries session capture after a navigation context loss", async () => {
  let calls = 0;
  const { browser, closeCount } = chromiumFixture({
    url: "https://chatgpt.com/",
    evaluate: async script => {
      calls++;
      if (script === "capture-session") {
        if (calls === 1) throw new Error("Cannot find context with specified id");
        return JSON.stringify({ user: { email: "fixture@example.invalid" }, accessToken: "private-access-token" });
      }
      return {};
    },
    cookies: [{ name: "session-token", value: "private-cookie" }],
  });

  browser.answer = { field: "code", value: "private-otp", deadline: Date.now() + 45000 };
  const waiting = await browser.snapshot();
  assert.deepEqual(waiting.frame, { phase: "login", step: "working" });
  assert.equal(browser.answer.value, "private-otp");

  const connected = await browser.snapshot();
  assert.equal(connected.frame.phase, "connected");
  assert.equal(connected.account.session.accessToken, "private-access-token");
  assert.equal(closeCount(), 0);
});

test("Chromium treats only the two navigation context errors as transient", async () => {
  assert.equal(isTransientBrowserTransition(navigationLoss()), true);
  assert.equal(isTransientBrowserTransition(new Error("frame.evaluate: Execution context was destroyed, most likely because of a navigation")), true);
  assert.equal(isTransientBrowserTransition(new Error("Cannot find context with specified id")), true);
  assert.equal(isTransientBrowserTransition(new Error("Target closed")), false);
  assert.equal(isTransientBrowserTransition(new Error("Invalid answer.")), false);

  const { browser } = chromiumFixture({ evaluate: async () => { throw new Error("Target closed"); } });
  await assert.rejects(browser.input({ action: "answer", field: "code", value: "fixture-code" }), /Target closed/);
  await assert.rejects(browser.snapshot(), /Target closed/);
});

test("Chromium does not extend the answer deadline after a navigation loss", async () => {
  const { browser } = chromiumFixture({ evaluate: async () => { throw navigationLoss(); } });
  browser.answer = { field: "code", value: "private-otp", deadline: Date.now() - 1 };
  const result = await browser.snapshot();
  assert.equal(result.frame.step, "error");
  assert.equal(result.frame.ask, "code");
  assert.equal(JSON.stringify(result.frame).includes("private-otp"), false);
  assert.equal(browser.answer, null);
});

test("login diagnostics retain counters and flags while dropping account and credential data", () => {
  assert.deepEqual(safeDiagnostic({ state: "complete", submits: 1, status: 401, trustedInput: false, email: "fixture@example.invalid", password: "private-fixture", url: "https://fixture.invalid/private", body: "private-fixture" }), { state: "complete", trustedInput: false, status: 401, submits: 1 });
  assert.deepEqual(safeDiagnostic({ state: "private-fixture", submits: "private-fixture", valid: "private-fixture", requests: -1 }), {});
});

test("native login has no renderer at construction and starts an isolated Linux WebView on demand", async () => {
  if (process.platform !== "linux") return;
  let launches = 0;
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stdin.on("data", data => {
    const request = JSON.parse(data);
    child.stdout.write(`${JSON.stringify({ id: request.id, result: request.action === "snapshot" ? { frame: { phase: "login" }, account: null } : {} })}\n`);
  });
  const browser = new NativeBrowser("fixture", (binary, args, options) => {
    launches++;
    assert.equal(binary, "xvfb-run");
    assert.ok(args.includes("-screen 0 430x740x24 -nolisten tcp"));
    assert.ok(args.at(-1).endsWith("native_webview.py"));
    assert.equal(options.detached, true);
    assert.equal(options.stdio[2], "pipe");
    return child;
  });
  assert.equal(launches, 0);
  await browser.start({ id: "chatgpt-web" });
  assert.equal(launches, 1);
  await browser.input({ action: "frame", id: "untrusted-id" });
  assert.deepEqual(await browser.snapshot(), { frame: { phase: "login" }, account: null });
  await browser.close();
  await assert.rejects(browser.snapshot());
});

test("a renderer failure releases the login resources without exposing engine errors", async () => {
  const key = randomBytes(32);
  let closes = 0;
  const browser = { start: async () => {}, close: async () => { closes++; }, snapshot: async () => { throw new Error("private-renderer-detail"); } };
  const service = new BrowserService(browser, new Map([["fixture", { id: "fixture" }]]), {});
  const result = await service.exchange(key, seal(key, { id: "failed", timestamp: Date.now(), action: "start", provider: "fixture" }, "request"));
  assert.equal(closes, 2);
  const frame = open(key, result.payload, "response");
  assert.equal(frame.phase, "error");
  assert.ok(!JSON.stringify(frame).includes("private-renderer-detail"));
});

test("login envelopes interoperate with phone WebCrypto and reject tampering and reflection", async () => {
  const key = randomBytes(32);
  const data = { id: "request-1", timestamp: Date.now(), action: "text", text: "fixture-secret" };
  const envelope = seal(key, data, "request");
  assert.ok(!JSON.stringify(envelope).includes(data.text));
  const webKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt", "encrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64"), additionalData: new TextEncoder().encode("lilo.browser.request.v1") }, webKey, Buffer.from(envelope.data, "base64"));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), data);
  assert.deepEqual(open(key, envelope, "request"), data);
  assert.throws(() => open(key, envelope, "response"));
  const altered = Buffer.from(envelope.data, "base64");
  altered[0] ^= 1;
  assert.throws(() => open(key, { ...envelope, data: altered.toString("base64") }, "request"));
});

test("expired, repeated and excessive encrypted requests cannot repeat a browser action", () => {
  const guard = new ReplayGuard();
  const now = Date.now();
  guard.accept({ id: "fresh", timestamp: now }, now);
  assert.throws(() => guard.accept({ id: "fresh", timestamp: now }, now));
  assert.throws(() => guard.accept({ id: "expired", timestamp: now - 121000 }, now));
  assert.throws(() => guard.accept({ id: "future", timestamp: now + 121000 }, now));
});

test("only an authenticated fresh request can control a browser, and credentials stay off the phone response", async () => {
  const key = randomBytes(32);
  let clicks = 0;
  const account = { provider: "fixture", session: { user: { email: "fixture.invalid" }, accessToken: "fixture-private-token" } };
  const browser = { start: async () => {}, close: async () => {}, input: async () => { clicks++; }, snapshot: async () => clicks ? ({ frame: { phase: "connected" }, account }) : ({ frame: { phase: "login" }, account: null }) };
  const service = new BrowserService(browser, new Map([["fixture", { id: "fixture" }]]), {});
  const start = seal(key, { id: "start", timestamp: Date.now(), action: "start", provider: "fixture" }, "request");
  const result = await service.exchange(key, start);
  assert.equal(result.account, null);
  assert.deepEqual(open(key, result.payload, "response"), { id: "start", phase: "login" });
  assert.ok(!JSON.stringify(result.payload).includes("fixture-private-token"));
  const click = seal(key, { id: "click", timestamp: Date.now(), action: "click" }, "request");
  const completed = await service.exchange(key, click);
  assert.deepEqual(completed.account, account);
  assert.deepEqual(open(key, completed.payload, "response"), { id: "click", phase: "connected" });
  await assert.rejects(service.exchange(key, click));
  assert.equal(clicks, 1);
  const wrong = randomBytes(32);
  const stolen = await service.exchange(wrong, seal(wrong, { id: "other", timestamp: Date.now(), action: "click" }, "request"));
  assert.equal(open(wrong, stolen.payload, "response").phase, "error");
  assert.equal(clicks, 1);
  await service.close();
});
