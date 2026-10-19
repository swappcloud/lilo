import { describe, expect, it, vi } from "vitest";
import engine from "../../../../src-tauri/assets/grok-voice-engine.js?raw";
import login from "../../../../src-tauri/assets/grok-login.js?raw";

const runInNewContext = (script: string, context: Record<string, unknown>) =>
  new Function(...Object.keys(context), script)(...Object.values(context));

function harness() {
  const reports: Array<{ token: string; events: Array<Record<string, unknown>> }> = [];
  const timers: Array<() => void> = [];
  const sockets: Socket[] = [];
  class Socket {
    readyState = 1;
    binaryType = "";
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    sent: Array<Record<string, unknown>> = [];
    constructor(readonly url: string) { sockets.push(this); }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  }
  const window = {
    __liloGrokVoiceCfg: { token: "current", voice: "ara", instructions: "A quoted \"prompt\"", language: "pt-BR" },
    __TAURI_INTERNALS__: { invoke: vi.fn(async (_name: string, args: typeof reports[number]) => { reports.push(args); }) },
    __liloGrokVoice: undefined as undefined | { send: (event: unknown, token?: string) => void; stop: () => void },
  };
  const context = {
    window, location: { origin: "https://grok.com" }, WebSocket: Socket,
    URL, TextDecoder, Date, Promise,
    setInterval: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearInterval: vi.fn(),
  };
  const flush = async () => { timers[0]?.(); await Promise.resolve(); await Promise.resolve(); };
  return { window, context, sockets, reports, flush };
}

describe("Grok same-origin engine", () => {
  it("answers server heartbeats with their timestamp", () => {
    const h = harness();
    runInNewContext(engine, h.context);
    h.sockets[0].onmessage?.({ data: JSON.stringify({ type: "ping", ping_timestamp: 12345 }) });
    expect(h.sockets[0].sent).toEqual([{ type: "pong", ping_timestamp: 12345, timestamp: expect.any(Number) }]);
  });
  it("opens the web voice transport and waits for conversation readiness", async () => {
    const h = harness();
    runInNewContext(engine, h.context);
    expect(h.sockets[0].url).toContain("wss://grok.com/ws/app_chat/stream_audio");
    expect(h.sockets[0].url).not.toContain("api.x.ai");
    h.sockets[0].onopen?.();
    expect(h.sockets[0].sent[0]).toMatchObject({ type: "session.update", session: { is_raw_instructions: true, instructions: "A quoted \"prompt\"" } });
    await h.flush();
    expect(h.reports).toEqual([]);
    h.sockets[0].onmessage?.({ data: JSON.stringify({ type: "conversation.created", conversation: { id: "c-1" } }) });
    await h.flush();
    expect(h.reports[0]).toMatchObject({ token: "current", events: [{ type: "ready", conversationId: "c-1" }, { type: "frame" }] });
  });

  it("reuses an injected session, rejects stale sends, and closes on cancellation", () => {
    const h = harness();
    runInNewContext(engine, h.context);
    runInNewContext(engine, h.context);
    expect(h.sockets).toHaveLength(1);
    h.window.__liloGrokVoice?.send({ type: "input_audio_buffer.append", audio: "AAA=" }, "old");
    expect(h.sockets[0].sent).toEqual([]);
    h.window.__liloGrokVoice?.stop();
    h.window.__liloGrokVoice?.send({ type: "response.create" });
    expect(h.sockets[0].readyState).toBe(3);
    expect(h.sockets[0].sent).toEqual([]);
  });

  it("decodes binary JSON and does not forward upstream error details", async () => {
    const h = harness();
    runInNewContext(engine, h.context);
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "conversation.created", conversation: { id: "c-2" } }));
    h.sockets[0].onmessage?.({ data: bytes.buffer });
    h.sockets[0].onmessage?.({ data: JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded", message: "private upstream detail" } }) });
    await h.flush();
    await h.flush();
    expect(JSON.stringify(h.reports)).toContain("c-2");
    expect(JSON.stringify(h.reports)).toContain("limiting voice requests");
    expect(JSON.stringify(h.reports)).not.toContain("private upstream detail");
  });
  it.each([
    ["concurrency_limit", "already has an active voice session"],
    ["rate_limit_exceeded", "limiting voice requests"],
    ["usage_pool_exhausted", "exhausted its voice allowance"],
    ["usage_limit_reached", "reached its voice allowance"],
  ])("reports %s separately and releases the refused socket", async (code, message) => {
    const h = harness();
    runInNewContext(engine, h.context);
    h.sockets[0].onmessage?.({ data: JSON.stringify({ type: "error", error: { code } }) });
    await h.flush();
    expect(h.reports.flatMap((report) => report.events)).toEqual([
      { type: "error", reason: code, message: expect.stringContaining(message) },
    ]);
    expect(h.sockets[0].readyState).toBe(3);
    h.window.__liloGrokVoice?.send({ type: "response.create" });
    expect(h.sockets[0].sent).toEqual([]);
    expect(h.context.clearInterval).toHaveBeenCalledTimes(2);
  });
  it("does not expose unknown error codes or messages", async () => {
    const h = harness();
    runInNewContext(engine, h.context);
    h.sockets[0].onmessage?.({ data: JSON.stringify({
      type: "error", error: { code: "private-code", message: "private-message" },
    }) });
    await h.flush();
    expect(h.reports[0].events[0]).toMatchObject({ type: "error", reason: "voice_request_rejected" });
    expect(JSON.stringify(h.reports)).not.toContain("private-");
  });

  it("downloads a finished generated picture once and reports it in parts", async () => {
    const h = harness();
    const fetch = vi.fn(async (_url: URL, _init?: RequestInit) => ({ ok: true, blob: async () => new Blob(["fox"], { type: "image/jpeg" }) }));
    runInNewContext(engine, { ...h.context, fetch, FileReader });
    const card = (progress: number) => ({
      type: "response.grok.output",
      card_attachment: JSON.stringify({
        id: "card-1", cardType: "generated_image_card",
      image_chunk: { imageUuid: "img-1", imageUrl: "users/test-user/generated/img-1/image.jpg", progress, seq: 1, imagePrompt: { prompt: "a red fox" } },
      }),
    });
    h.sockets[0].onmessage?.({ data: JSON.stringify(card(40)) });
    h.sockets[0].onmessage?.({ data: JSON.stringify(card(100)) });
    h.sockets[0].onmessage?.({ data: JSON.stringify(card(100)) });
    await vi.waitFor(() => expect(JSON.stringify(h.reports)).toContain("\"type\":\"image\""));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://assets.grok.com/users/test-user/generated/img-1/image.jpg");
    const image = h.reports.flatMap((report) => report.events).find((event) => event.type === "image");
    expect(image).toMatchObject({ id: "img-1", part: 0, parts: 1, mime: "image/jpeg", prompt: "a red fox", data: btoa("fox") });
  });

  it("reports refusal before readiness instead of connecting silently", async () => {
    const h = harness();
    runInNewContext(engine, h.context);
    h.sockets[0].onclose?.({ code: 1008 });
    await h.flush();
    expect(h.reports[0].events).toMatchObject([{ type: "closed", code: 1008 }, { type: "error" }]);
  });
});

describe("Grok login", () => {
  it("maps display identity without credentials and rejects anonymous visitors", async () => {
    const location = { origin: "https://grok.com", href: "" };
    const window: Record<string, unknown> = {};
    window.top = window.self = window;
    let check: (() => Promise<void>) | undefined;
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ user: { userId: "anon", email: "", isAnonymous: true } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ user: { userId: "user-1", name: "Fixture User", privateToken: "fixture-private-token", email: "test@example.invalid" } }) });
    runInNewContext(login, { window, location, fetch, setInterval: (fn: () => Promise<void>) => { check = fn; return 1; }, clearInterval: vi.fn(), TextEncoder, btoa });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(location.href).toBe("");
    await check?.();
    const profile = JSON.parse(atob(location.href.split("#")[1]));
    expect(profile).toEqual({ name: "Fixture User", email: "test@example.invalid" });
    expect(location.href).not.toContain("fixture-private-token");
    expect(location.href).not.toContain("test@example.invalid");
  });
});
