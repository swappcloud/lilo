import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { NativeBrowser } from "./browser.mjs";
import { ChromiumBrowser } from "./chromium_browser.mjs";
import { providers } from "./providers/registry.mjs";
import { BrowserService } from "./service.mjs";
import { PulseAudio } from "./audio.mjs";
import { VoiceService } from "./voice_service.mjs";

const token = (await readFile(process.env.LILO_BROWSER_TOKEN_FILE, "utf8")).trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("A private browser-host token file is required.");
const Engine = process.env.LILO_BROWSER_ENGINE === "webkitgtk" ? NativeBrowser : ChromiumBrowser;
const service = new BrowserService(new Engine(process.env.LILO_BROWSER_DATA_DIR), providers, new PulseAudio());
const voice = new VoiceService(service.browser, providers);
let busy = false;
const server = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  const supplied = request.headers["x-lilo-browser-token"];
  if (typeof supplied !== "string" || supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
    response.writeHead(403).end('{"error":"Forbidden."}'); return;
  }
  if (request.method === "GET" && request.url === "/capabilities") {
    response.end(JSON.stringify({ providers: [...providers.keys()], voiceProviders: Engine === ChromiumBrowser ? [...providers.values()].filter(provider => provider.voice === true).map(provider => provider.id) : [], audio: await service.audio.status(), engine: service.browser.status() })); return;
  }
  if (request.method === "POST" && request.url === "/voice") {
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString("utf8");
        if (Buffer.byteLength(body) > 131072) throw new Error("Request too large.");
      }
      const result = await voice.handle(JSON.parse(body));
      const diagnostic = voice.diagnostic();
      if (diagnostic) console.warn(JSON.stringify({ event: "voice-error", ...diagnostic }));
      response.end(JSON.stringify(result));
    } catch (error) {
      const message = typeof error?.message === "string" ? error.message : "Voice request failed.";
      const allowed = new Set(["Invalid voice request.", "Provider voice is unavailable.", "A signed-in account is required.", "Invalid voice options.", "The login browser is currently in use.", "A voice operation is already in progress.", "A voice session is already active.", "Voice session is not connected.", "Invalid mute state.", "Invalid voice text.", "Unsupported voice action."]);
      response.writeHead(400).end(JSON.stringify({ error: allowed.has(message) ? message : "Voice request failed." }));
    }
    return;
  }
  if (request.method === "POST" && ["/exchange", "/forget"].includes(request.url) && voice.isActive()) {
    response.writeHead(409).end('{"error":"Browser request unavailable."}'); return;
  }
  if (request.method !== "POST" || !["/exchange", "/forget"].includes(request.url) || busy) {
    response.writeHead(409).end('{"error":"Browser request unavailable."}'); return;
  }
  busy = true;
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body) > 65536) throw new Error("Request too large.");
    }
    const input = JSON.parse(body);
    if (request.url === "/forget") {
      if (typeof input.provider !== "string" || typeof input.email !== "string" || input.email.length > 320) throw new Error("Invalid request.");
      await service.forget(input.provider, input.email);
      response.end('{"ok":true}');
    } else {
      if (typeof input.key !== "string" || !/^[a-f0-9]{64}$/.test(input.key)) throw new Error("Invalid key.");
      response.end(JSON.stringify(await service.exchange(Buffer.from(input.key, "hex"), input.payload)));
    }
  } catch { response.writeHead(400).end('{"error":"Browser request failed."}'); }
  finally { busy = false; }
});
server.requestTimeout = 90000;
server.headersTimeout = 10000;
server.listen(Number(process.env.LILO_BROWSER_PORT ?? 8790), process.env.LILO_BROWSER_BIND ?? "127.0.0.1");
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try { await service.expire(); } finally { busy = false; }
}, 10000);
const voiceLeaseTimer = setInterval(() => { void voice.expire().catch(() => {}); }, 1000);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, async () => {
  clearInterval(timer); clearInterval(voiceLeaseTimer); server.close(); await Promise.all([service.close(), voice.close()]); process.exit(0);
});
