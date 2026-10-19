const MAX_EVENTS = 64;
const OP_TIMEOUT_MS = 60000;
const LEASE_MS = 20000;

/** Voice lifecycle stays separate from the phone-login state machine. */
export class VoiceService {
  #state = "idle";
  #muted = false;
  #providerId = null;
  #sessionId = null;
  #error = null;
  #diagnostic = null;
  #diagnosticReported = false;
  #events = [];
  #lastBrowserSequence = 0;
  #ownsBrowser = false;
  #operation = false;
  #generation = 0;
  #lastActivity = 0;
  #lastTransportReport = 0;

  constructor(browser, providers) { this.browser = browser; this.providers = providers; }

  async handle(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.action !== "string") throw new Error("Invalid voice request.");
    if (!["start", "status", "stop", "mute", "interrupt", "text", "heartbeat"].includes(input.action)) throw new Error("Unsupported voice action.");
    this.#lastActivity = Date.now();
    switch (input.action) {
      case "heartbeat": return { state: this.#state };
      case "status": await this.#collect(); return this.#snapshot();
      case "start": return this.#start(input);
      case "stop": return this.#stop();
      case "mute": return this.#mute(input.muted);
      case "interrupt": return this.#simple("interrupt");
      case "text": return this.#text(input);
      default: throw new Error("Unsupported voice action.");
    }
  }

  async #start(input) {
    this.#assertIdle();
    const provider = this.providers.get(input.providerId);
    if (!provider?.voice || typeof this.browser.voiceAction !== "function") throw new Error("Provider voice is unavailable.");
    const account = input.account;
    if (!account || typeof account.accessToken !== "string" || !account.accessToken || account.accessToken.length > 32768 || typeof account.sessionCookie !== "string" || !account.sessionCookie || account.sessionCookie.length > 65536 || (account.deviceId != null && (typeof account.deviceId !== "string" || account.deviceId.length > 128))) throw new Error("A signed-in account is required.");
    const options = input.options && typeof input.options === "object" ? input.options : {};
    if ([options.voice, options.voiceMode, options.languageCode, options.prompt, options.directive].some(value => value != null && (typeof value !== "string" || value.length > (value === options.prompt || value === options.directive ? 8000 : 80)))) throw new Error("Invalid voice options.");
    if ((options.prompt?.length ?? 0) + (options.directive?.length ?? 0) > 8192) throw new Error("Voice instructions are too long.");
    if (this.browser.status().running && this.browser.mode !== "voice") throw new Error("The login browser is currently in use.");
    this.#operation = true;
    const generation = ++this.#generation;
    this.#state = "starting";
    this.#providerId = provider.id;
    this.#error = null;
    this.#diagnostic = null;
    this.#diagnosticReported = false;
    this.#events = [];
    this.#lastBrowserSequence = 0;
    this.#lastTransportReport = 0;
    try {
      await this.#withTimeout((async () => {
        this.#ownsBrowser = true;
        await this.browser.start(provider, { mode: "voice", account });
        if (generation !== this.#generation) return;
        const result = await this.browser.voiceAction("start", { options });
        if (generation !== this.#generation) return;
        this.#merge(result);
        if (this.#state !== "connected") throw new Error("Voice connection did not complete.");
      })());
      return this.#snapshot();
    } catch (error) {
      if (generation !== this.#generation) return this.#snapshot();
      ++this.#generation;
      this.#state = "error";
      const browserDiagnostic = sanitizeDiagnostic(this.browser.voiceDiagnostics?.());
      this.#diagnostic = browserDiagnostic ?? (/timed out/i.test(error?.message ?? "") ? { stage: "browser", category: "timeout" } : { stage: "browser", category: "browser-failure" });
      this.#error = publicDiagnostic(this.#diagnostic);
      await this.#closeOwned();
      return this.#snapshot();
    } finally { this.#operation = false; }
  }

  async #stop() {
    if (this.#state === "starting") {
      ++this.#generation;
      await this.#closeOwned();
      this.#state = "idle";
      this.#muted = false;
      this.#providerId = null;
      this.#sessionId = null;
      this.#error = null;
      this.#diagnostic = null;
      this.#diagnosticReported = false;
      this.#events = [];
      this.#lastBrowserSequence = 0;
      return this.#snapshot();
    }
    if (this.#operation) throw new Error("A voice operation is already in progress.");
    this.#operation = true;
    try {
      if (this.#ownsBrowser) {
        await this.browser.voiceAction("stop").catch(() => {});
        await this.#closeOwned();
      }
      this.#state = "idle";
      this.#muted = false;
      this.#providerId = null;
      this.#sessionId = null;
      this.#error = null;
      this.#diagnostic = null;
      this.#diagnosticReported = false;
      this.#events = [];
      this.#lastBrowserSequence = 0;
      return this.#snapshot();
    } finally { this.#operation = false; }
  }

  async #mute(muted) {
    if (typeof muted !== "boolean") throw new Error("Invalid mute state.");
    return this.#mutate(async () => this.#merge(await this.browser.voiceAction("mute", { muted })));
  }

  async #simple(action) {
    return this.#mutate(async () => this.#merge(await this.browser.voiceAction(action)));
  }

  async #text(request) {
    const text = typeof request === "string" ? request : request?.text;
    const hidden = typeof request === "object" && request !== null && request.hidden === true;
    if (typeof request === "object" && request !== null && request.hidden != null && typeof request.hidden !== "boolean") throw new Error("Invalid voice text.");
    if (typeof text !== "string" || !text.trim() || text.length > (hidden ? 16000 : 4000)) throw new Error("Invalid voice text.");
    return this.#mutate(async () => this.#merge(await this.browser.voiceAction("text", { text, hidden })), true);
  }

  async #mutate(action, propagateFailure = false) {
    if (this.#state !== "connected" || !this.#ownsBrowser) throw new Error("Voice session is not connected.");
    if (this.#operation) throw new Error("A voice operation is already in progress.");
    this.#operation = true;
    this.#diagnostic = null;
    this.#diagnosticReported = false;
    this.#error = null;
    try {
      await action();
      await this.#collect();
      if (this.#state === "error") {
        this.#diagnostic = sanitizeDiagnostic(this.browser.voiceDiagnostics?.()) ?? { stage: "connected", category: "connection-lost" };
        this.#error = publicDiagnostic(this.#diagnostic);
        await this.#cleanupFailedConnection();
      }
      return this.#snapshot();
    }
    catch {
      this.#diagnostic = sanitizeDiagnostic(this.browser.voiceDiagnostics?.()) ?? { stage: "connected", category: "unknown" };
      this.#error = publicDiagnostic(this.#diagnostic);
      if (propagateFailure) throw new Error("Voice operation failed.");
      return this.#snapshot();
    }
    finally { this.#operation = false; }
  }

  async #collect() {
    if (this.#ownsBrowser && this.#state === "connected") {
      try {
        const previous = this.#state;
        this.#merge(await this.browser.voiceAction("status", { after: this.#lastBrowserSequence }));
        if (process.env.LILO_VOICE_DIAGNOSTICS === "1" && this.#state === "connected" && Date.now() - this.#lastTransportReport >= 10000) {
          this.#lastTransportReport = Date.now();
          try {
            const transport = await this.browser.voiceAction("transportDiagnostics");
            const fields = ["connectionState", "iceConnectionState", "iceGatheringState", "dataChannelState"];
            const safe = {};
            for (const key of fields) if (["new", "checking", "connecting", "connected", "completed", "disconnected", "failed", "closed", "gathering", "complete", "open", "closing"].includes(transport?.[key])) safe[key] = transport[key];
            for (const key of ["sentMessages", "receivedMessages"]) if (Number.isSafeInteger(transport?.[key]) && transport[key] >= 0) safe[key] = transport[key];
            for (const key of ["microphone", "inboundAudio", "outboundAudio"]) {
              safe[key] = {};
              for (const metric of ["packets", "bytes", "audioLevel", "totalAudioEnergy"]) {
                const value = transport?.[key]?.[metric];
                if (typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key][metric] = value;
              }
            }
            safe.remoteAudio = { attached: transport?.remoteAudio?.attached === true, paused: transport?.remoteAudio?.paused !== false };
            console.info(JSON.stringify({ event: "voice-transport", ...safe }));
          } catch { /* Diagnostics must not interrupt a voice session. */ }
        }
        if (previous === "connected" && this.#state === "idle") {
          this.#state = "error";
          this.#error = "The voice connection ended.";
        }
        if (this.#state === "error") {
          this.#diagnostic = sanitizeDiagnostic(this.browser.voiceDiagnostics?.()) ?? { stage: "connected", category: "connection-lost" };
          this.#error = publicDiagnostic(this.#diagnostic);
          await this.#cleanupFailedConnection();
        }
      }
      catch {
        this.#state = "error";
        this.#diagnostic = sanitizeDiagnostic(this.browser.voiceDiagnostics?.()) ?? { stage: "connected", category: "connection-lost" };
        this.#error = publicDiagnostic(this.#diagnostic);
        await this.#closeOwned();
      }
    }
  }

  #merge(result) {
    if (!result || typeof result !== "object") return;
    if (["idle", "starting", "connected", "error"].includes(result.state)) this.#state = result.state;
    this.#muted = result.muted === true;
    if (typeof result.sessionId === "string" && result.sessionId.length <= 80) this.#sessionId = result.sessionId;
    for (const event of Array.isArray(result.events) ? result.events : []) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= this.#lastBrowserSequence || !["user", "assistant"].includes(event.speaker) || typeof event.text !== "string") continue;
      const safe = { sequence: event.sequence, speaker: event.speaker, text: utf8Prefix(event.text, 4096), final: event.final === true, ...(typeof event.turnId === "string" && event.turnId.length <= 128 ? { turnId: event.turnId } : {}) };
      const prior = safe.turnId ? this.#events.findIndex(item => item.speaker === safe.speaker && item.turnId === safe.turnId) : -1;
      if (prior >= 0) this.#events[prior] = safe;
      else this.#events.push(safe);
      this.#events.sort((left, right) => left.sequence - right.sequence);
      this.#lastBrowserSequence = event.sequence;
      if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
    }
  }

  #snapshot() {
    return {
      state: this.#state,
      muted: this.#muted,
      ...(this.#sessionId ? { sessionId: this.#sessionId } : {}),
      ...(this.#providerId ? { providerId: this.#providerId } : {}),
      ...(this.#error ? { error: this.#error } : {}),
      events: this.#events.map(event => ({ ...event })),
    };
  }

  #assertIdle() {
    if (this.#operation) throw new Error("A voice operation is already in progress.");
    if (this.#state === "starting" || this.#state === "connected") throw new Error("A voice session is already active.");
  }

  async #withTimeout(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Voice startup timed out.")), OP_TIMEOUT_MS); })]);
    } finally { clearTimeout(timer); }
  }

  async #closeOwned() {
    if (!this.#ownsBrowser) return;
    this.#ownsBrowser = false;
    await this.browser.close();
  }

  async #cleanupFailedConnection() {
    this.#error ??= "The voice connection ended.";
    if (this.#ownsBrowser) await this.browser.voiceAction("stop").catch(() => {});
    await this.#closeOwned();
  }

  async close() { await this.#closeOwned(); }
  isActive() { return this.#ownsBrowser || this.#state === "starting" || this.#state === "connected"; }
  diagnostic() {
    if (!this.#diagnostic || this.#diagnosticReported) return null;
    this.#diagnosticReported = true;
    return { ...this.#diagnostic };
  }

  async expire(now = Date.now()) {
    if (this.#ownsBrowser && (this.#state === "connected" || this.#state === "starting") && now - this.#lastActivity >= LEASE_MS) {
      await this.#stop();
      return true;
    }
    return false;
  }
}

function utf8Prefix(value, limit) {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limit) break;
    bytes += size;
    result += character;
  }
  return result;
}

function sanitizeDiagnostic(value) {
  if (!value || typeof value !== "object") return null;
  const stages = new Set(["browser", "session", "microphone", "offer", "ice", "provider-answer", "connected"]);
  const categories = new Set(["audio-permission", "audio-device-missing", "timeout", "network", "provider-response", "expired-session", "invalid-answer", "offer-failed", "navigation", "connection-lost", "browser-failure", "unknown"]);
  if (!stages.has(value.stage) || !categories.has(value.category)) return null;
  return { stage: value.stage, category: value.category, ...(Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? { status: value.status } : {}) };
}

function publicDiagnostic(value) {
  if (value.category === "provider-response" && value.status) return `ChatGPT returned HTTP ${value.status} during ${value.stage}.`;
  const messages = {
    "audio-permission": "Microphone permission was denied.",
    "audio-device-missing": "No microphone device is available.",
    timeout: `Voice startup timed out during ${value.stage}.`,
    network: `A network request failed during ${value.stage}.`,
    "expired-session": "The saved ChatGPT sign-in has expired.",
    "invalid-answer": "ChatGPT returned an invalid voice answer.",
    "offer-failed": "The browser could not create a voice offer.",
    navigation: "The voice browser navigated away during startup.",
    "connection-lost": "The voice connection ended.",
    "browser-failure": "The voice browser failed during startup.",
    unknown: `Voice startup failed during ${value.stage}.`,
  };
  return messages[value.category] ?? `Voice startup failed during ${value.stage}.`;
}
