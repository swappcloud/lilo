import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { VoiceService } from "../packages/daemon-browser-host/src/voice_service.mjs";
import { parseSessionCookies } from "../packages/daemon-browser-host/src/chromium_browser.mjs";
import { providers } from "../packages/daemon-browser-host/src/providers/registry.mjs";

const account = { accessToken: "private-access-token", sessionCookie: "__Secure-next-auth.session-token=private-cookie", deviceId: "device-test" };

test("voice restore accepts only scoped secure ChatGPT session cookies", () => {
  const cookies = parseSessionCookies("__Secure-next-auth.session-token=part-a; __Secure-next-auth.session-token.1=part-b", "https://chatgpt.com/");
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every(cookie => cookie.url === "https://chatgpt.com/" && cookie.secure && cookie.httpOnly && cookie.sameSite === "Lax"));
  assert.throws(() => parseSessionCookies("unrelated=secret", "https://chatgpt.com/"), /Invalid account cookie/);
});

test("ChatGPT response classification logs only session and voice endpoint categories", () => {
  const provider = providers.get("chatgpt-web");
  assert.equal(provider.responseCategory("https://chatgpt.com/api/auth/session", "GET"), "session");
  assert.equal(provider.responseCategory("https://chatgpt.com/realtime/wm?dcid=0", "POST"), "voice");
  assert.equal(provider.responseCategory("https://chatgpt.com/backend-api/me", "GET"), null);
});

class FakeBrowser {
  constructor() { this.mode = null; this.running = false; this.calls = []; this.events = []; this.failStart = false; this.failMute = false; this.failureDiagnostic = null; }
  status() { return { running: this.running }; }
  async start(provider, options) { this.calls.push(["start", provider.id, options]); this.mode = options.mode; this.running = true; }
  async voiceAction(action, payload) {
    this.calls.push([action, payload]);
    if (action === "start" && this.failStart) throw new Error("Voice browser action failed.");
    if (action === "mute" && this.failMute) throw new Error("Voice browser action failed.");
    if (action === "start") return { state: "connected", muted: false, sessionId: "CALL-1", events: [] };
    if (action === "mute") { this.muted = payload.muted; return { state: "connected", muted: this.muted, sessionId: "CALL-1", events: [] }; }
    if (action === "stop") return { state: "idle", muted: false, events: [] };
    if (action === "status") return { state: "connected", muted: this.muted === true, sessionId: "CALL-1", events: this.events.filter(event => event.sequence > payload.after) };
    return { state: "connected", muted: false, sessionId: "CALL-1", events: [] };
  }
  voiceDiagnostics() { return this.failureDiagnostic; }
  async close() { this.calls.push(["close"]); this.running = false; this.mode = null; }
}

test("voice service validates start and never returns account credentials", async () => {
  const browser = new FakeBrowser();
  const service = new VoiceService(browser, providers);
  await assert.rejects(service.handle({ action: "start", providerId: "chatgpt-web", account, options: { prompt: "x".repeat(7000), directive: "y".repeat(2000) } }), /too long/);
  const started = await service.handle({ action: "start", providerId: "chatgpt-web", account, options: { voice: "cove", languageCode: "en-US", prompt: "Be concise." } });
  assert.equal(started.state, "connected");
  assert.equal(started.providerId, "chatgpt-web");
  assert.equal(started.sessionId, "CALL-1");
  assert.equal(JSON.stringify(started).includes(account.accessToken), false);
  assert.equal(JSON.stringify(started).includes(account.sessionCookie), false);
  assert.deepEqual(browser.calls[1], ["start", { options: { voice: "cove", languageCode: "en-US", prompt: "Be concise." } }]);
  await assert.rejects(service.handle({ action: "start", providerId: "chatgpt-web", account, options: {} }), /already active/);
  const muted = await service.handle({ action: "mute", muted: true });
  assert.equal(muted.muted, true);
  await service.handle({ action: "interrupt" });
  await service.handle({ action: "text", text: "Hello" });
  await service.handle({ action: "text", text: "Private command context", hidden: true });
  assert.deepEqual(browser.calls.filter(call => call[0] === "text").at(-1), ["text", { text: "Private command context", hidden: true }]);
  const stopped = await service.handle({ action: "stop" });
  assert.equal(stopped.state, "idle");
  assert.equal(browser.running, false);
});

test("voice startup diagnostics expose only safe stage, category, and HTTP status", async () => {
  const browser = new FakeBrowser();
  browser.failStart = true;
  browser.failureDiagnostic = { stage: "provider-answer", category: "provider-response", status: 429, token: "must-not-leak" };
  const service = new VoiceService(browser, providers);
  const result = await service.handle({ action: "start", providerId: "chatgpt-web", account, options: {} });
  assert.equal(result.state, "error");
  assert.equal(result.error, "ChatGPT returned HTTP 429 during provider-answer.");
  assert.deepEqual(service.diagnostic(), { stage: "provider-answer", category: "provider-response", status: 429 });
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(service.diagnostic()).includes(account.accessToken), false);
});

test("microphone permission failure is reported safely while the call remains connected", async () => {
  const browser = new FakeBrowser();
  const service = new VoiceService(browser, providers);
  await service.handle({ action: "start", providerId: "chatgpt-web", account, options: {} });
  browser.failMute = true;
  browser.failureDiagnostic = { stage: "microphone", category: "audio-permission", details: "private browser error" };
  const result = await service.handle({ action: "mute", muted: false });
  assert.equal(result.state, "connected");
  assert.equal(result.error, "Microphone permission was denied.");
  assert.deepEqual(service.diagnostic(), { stage: "microphone", category: "audio-permission" });
  await service.handle({ action: "stop" });
});

test("voice status keeps events bounded, ordered, and free of credentials", async () => {
  const browser = new FakeBrowser();
  const service = new VoiceService(browser, providers);
  await service.handle({ action: "start", providerId: "chatgpt-web", account, options: {} });
  browser.events = Array.from({ length: 120 }, (_, index) => ({ sequence: index + 1, speaker: index % 2 ? "assistant" : "user", text: index === 56 ? "😀".repeat(2000) : `caption ${index}`, final: true }));
  const status = await service.handle({ action: "status" });
  assert.equal(status.events.length, 64);
  assert.equal(status.events[0].sequence, 57);
  assert.equal(status.events.at(-1).sequence, 120);
  assert.equal(Buffer.byteLength(status.events[0].text, "utf8"), 4096);
  assert.equal(JSON.stringify(status).includes("private-cookie"), false);
  await service.close();
});

test("voice heartbeat renews ownership without collecting browser captions", async () => {
  const browser = new FakeBrowser();
  const service = new VoiceService(browser, providers);
  await service.handle({ action: "start", providerId: "chatgpt-web", account, options: {} });
  browser.voiceAction = async () => { throw new Error("Unexpected browser access"); };
  assert.deepEqual(await service.handle({ action: "heartbeat" }), { state: "connected" });
  await service.close();
});

test("voice lease closes Chromium after daemon status heartbeats stop", async () => {
  const browser = new FakeBrowser();
  const service = new VoiceService(browser, providers);
  await service.handle({ action: "start", providerId: "chatgpt-web", account, options: {} });
  assert.equal(await service.expire(Date.now() + 19000), false);
  assert.equal(await service.expire(Date.now() + 21000), true);
  assert.equal(browser.running, false);
  assert.equal((await service.handle({ action: "status" })).state, "idle");
});

test("voice service folds streamed caption revisions into the same turn", async () => {
  const browser = new FakeBrowser();
  const service = new VoiceService(browser, providers);
  await service.handle({ action: "start", providerId: "chatgpt-web", account, options: {} });
  browser.events = [{ sequence: 1, speaker: "assistant", text: "hel", final: false, turnId: "turn-1" }];
  await service.handle({ action: "status" });
  browser.events = [
    { sequence: 1, speaker: "assistant", text: "hel", final: false, turnId: "turn-1" },
    { sequence: 2, speaker: "assistant", text: "hello", final: true, turnId: "turn-1" },
  ];
  const status = await service.handle({ action: "status" });
  assert.equal(status.events.length, 1);
  assert.equal(status.events[0].sequence, 2);
  assert.equal(status.events[0].text, "hello");
  assert.equal(status.events[0].final, true);
  await service.close();
});

test("voice browser bundle negotiates with fake WebRTC and uses shared channel helpers", async () => {
  const source = await readFile(".tmp/daemon-voice/voice.js", "utf8");
  const sent = [];
  const requests = [];
  const tracks = [];
  class FakeTrack { stop() { this.stopped = true; } }
  class FakeStream { constructor(items = []) { this.items = items; } getAudioTracks() { return this.items; } getTracks() { return this.items; } }
  class FakeChannel {
    readyState = "connecting";
    onopen = null;
    onmessage = null;
    send(data) { sent.push(JSON.parse(data)); }
    close() { this.readyState = "closed"; }
  }
  class FakePeer {
    iceGatheringState = "gathering";
    connectionState = "connected";
    localDescription = null;
    channel = null;
    sender = null;
    iceListeners = new Set();
    createDataChannel(name, options) { assert.equal(name, "oai-events"); assert.deepEqual({ ...options }, { negotiated: true, id: 0 }); this.channel = new FakeChannel(); return this.channel; }
    addTrack(track) { this.sender = { track, async replaceTrack(next) { this.track = next; } }; return this.sender; }
    async createOffer() { return { type: "offer", sdp: "v=0\r\na=fake\r\n" }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) {
      assert.equal(value.type, "answer");
      assert.match(value.sdp, /^v=0\r\n/);
      this.remote = value;
    }
    async getStats() { return new Map([
      ["private-source", { type: "media-source", kind: "audio", audioLevel: 0.2, totalAudioEnergy: 3, deviceId: "private-device" }],
      ["private-remote", { type: "inbound-rtp", kind: "audio", packetsReceived: 20, bytesReceived: 200, address: "private-address" }],
    ]); }
    addEventListener(_name, callback) { this.iceListeners.add(callback); }
    removeEventListener(_name, callback) { this.iceListeners.delete(callback); }
    close() { this.connectionState = "closed"; }
  }
  let peer;
  let micCalls = 0;
  let providerStatus = 200;
  let micFailure = null;
  class FakeFormData { constructor() { this.fields = new Map(); } append(key, value) { this.fields.set(key, value); } }
  const sandbox = {
    window: null,
    crypto: webcrypto,
    RTCPeerConnection: class extends FakePeer { constructor(options) { super(); peer = this; assert.equal(options.bundlePolicy, "max-bundle"); } },
    MediaStream: FakeStream,
    FormData: FakeFormData,
    AbortSignal,
    Intl,
    Date,
    setTimeout: (callback, delay) => delay === 2500 ? (queueMicrotask(callback), 1) : setTimeout(callback, delay),
    clearTimeout,
    queueMicrotask,
    document: {
      body: { append() {} },
      createElement: () => ({ autoplay: false, playsInline: false, srcObject: null, dataset: {}, play: async () => {}, pause() {}, remove() {} }),
      querySelectorAll: () => [],
    },
    navigator: { mediaDevices: { getUserMedia: async () => { micCalls++; if (micFailure) throw micFailure; const track = new FakeTrack(); tracks.push(track); return new FakeStream([track]); } } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === "/api/auth/session") return { ok: true, json: async () => ({ accessToken: "browser-owned-token" }) };
      assert.equal(url, "/realtime/wm?dcid=0");
      assert.equal(options.credentials, "include");
      assert.equal(options.headers.authorization, "Bearer browser-owned-token");
      assert.equal(options.headers["oai-device-id"], "device-test");
      assert.equal(options.body.fields.get("sdp"), "v=0\r\na=fake\r\n");
      const session = JSON.parse(options.body.fields.get("session"));
      assert.equal(session.voice_session_id, session.voice_status_request_id);
      assert.equal(session.voice, "cove");
      assert.deepEqual(session.client_tools, []);
      if (providerStatus !== 200) return { ok: false, status: providerStatus, text: async () => "private response body" };
      return { ok: true, status: 200, text: async () => "v=0\na=answer\n" };
    },
  };
  sandbox.window = sandbox;
  sandbox.__liloDeviceId = "device-test";
  runInNewContext(source, sandbox);
  let startCompleted = false;
  const starting = sandbox.__liloVoice.start({ voice: "cove", voiceMode: "standard", languageCode: "en-US", prompt: "Hidden setup", directive: "Answer in English." }).then(result => {
    startCompleted = true;
    return result;
  });
  while (!peer?.remote) await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(startCompleted, false, "startup waits for the negotiated data channel");
  peer.channel.readyState = "open";
  peer.channel.onopen();
  assert.equal(startCompleted, false, "startup waits for the opening context send");
  await new Promise(resolve => setTimeout(resolve, 620));
  assert.equal(startCompleted, false, "startup waits for the separate language instruction");
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0].data).payload.message.content.parts[0], "Hidden setup");
  const connected = await starting;
  assert.equal(connected.state, "connected");
  assert.equal(peer.iceListeners.size, 0, "ICE fallback removes the gathering listener");
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[1].options.body.fields.get("session")).voice_mode, "standard");
  assert.equal(requests[1].options.body.fields.get("session").includes("Hidden setup"), false);
  assert.equal(JSON.parse(sent[0].data).payload.message.content.parts[0], "Hidden setup");
  assert.match(JSON.parse(sent[0].data).payload.message.id, /^lilo-context-/);
  assert.equal(JSON.parse(sent[1].data).payload.message.content.parts[0], "Answer in English.");
  assert.match(JSON.parse(sent[1].data).payload.message.id, /^lilo-context-/);
  await sandbox.__liloVoice.setMuted(true);
  assert.equal(peer.sender.track, null);
  assert.equal(tracks[0].stopped, true);
  await sandbox.__liloVoice.setMuted(false);
  assert.equal(micCalls, 2);
  assert.equal(peer.sender.track, tracks[1]);
  await sandbox.__liloVoice.text("Hello");
  await sandbox.__liloVoice.interrupt();
  assert.equal(sent[0].type, "data_message");
  assert.equal(JSON.parse(sent[2].data).type, "relay_message");
  assert.equal(JSON.parse(sent[3].data).payload.action, "stop_speaking");
  const echo = (id, text, role = "user") => ({ data: JSON.stringify({ type: "data_message", data: JSON.stringify({ type: "chat_message_delta", delta: { v: { message: { id, author: { role }, content: { parts: [{ text }] } } } } }) }) });
  peer.channel.onmessage(echo(JSON.parse(sent[0].data).payload.message.id, "Hidden setup"));
  assert.equal(sandbox.__liloVoice.snapshot().events.length, 0);
  await sandbox.__liloVoice.text("Private tool context", true);
  const hiddenText = JSON.parse(sent[4].data).payload.message;
  assert.match(hiddenText.id, /^lilo-context-/);
  peer.channel.onmessage(echo(hiddenText.id, "Private tool context"));
  assert.equal(sandbox.__liloVoice.snapshot().events.length, 0);
  await sandbox.__liloVoice.text("Hello");
  const visibleText = JSON.parse(sent[5].data).payload.message;
  peer.channel.onmessage(echo(visibleText.id, "Hello"));
  assert.equal(sandbox.__liloVoice.snapshot().events.at(-1).text, "Hello");
  const caption = text => ({ data: JSON.stringify({ type: "data_message", data: JSON.stringify({ type: "chat_message_delta", delta: { v: { message: { id: "turn-1", author: { role: "assistant" }, content: { parts: [{ text }] } } } } }) }) });
  peer.channel.onmessage(caption("hel"));
  peer.channel.onmessage(caption("hello"));
  const status = sandbox.__liloVoice.snapshot();
  assert.equal(status.events.find(event => event.turnId === "turn-1").text, "hello");
  assert.equal(status.events.find(event => event.turnId === "turn-1").sequence, 4);
  assert.equal(status.events.find(event => event.turnId === visibleText.id).final, true);
  peer.channel.onmessage({ data: JSON.stringify({ type: "data_message", data: JSON.stringify({ type: "state_update", payload: { new_state: "listening" } }) }) });
  assert.equal(sandbox.__liloVoice.snapshot().events.find(event => event.turnId === "turn-1").final, true);
  assert.equal(status.events.length, 2);
  const transport = await sandbox.__liloVoice.transportDiagnostics();
  assert.equal(transport.microphone.audioLevel, 0.2);
  assert.equal(transport.microphone.totalAudioEnergy, 3);
  assert.equal(transport.inboundAudio.packets, 20);
  assert.equal(JSON.stringify(transport).includes("private-"), false);
  await sandbox.__liloVoice.stop();
  assert.equal(sandbox.__liloVoice.snapshot().state, "idle");
  providerStatus = 429;
  await assert.rejects(sandbox.__liloVoice.start({ voice: "cove" }), /LILO_VOICE\|provider-answer\|provider-response\|429/);
  assert.equal(JSON.stringify(sandbox.__liloVoice.diagnostics()), JSON.stringify({ stage: "provider-answer", category: "provider-response", status: 429 }));
  providerStatus = 200;
  micFailure = Object.assign(new Error("private browser detail"), { name: "NotAllowedError" });
  await assert.rejects(sandbox.__liloVoice.start({ voice: "cove" }), /LILO_VOICE\|microphone\|audio-permission/);
  assert.equal(JSON.stringify(sandbox.__liloVoice.diagnostics()), JSON.stringify({ stage: "microphone", category: "audio-permission" }));
});
