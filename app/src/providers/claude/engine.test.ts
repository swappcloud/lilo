import { describe, expect, it, vi } from "vitest";
import engine from "../../../../src-tauri/assets/claude-voice-engine.js?raw";

function harness() {
  const sockets: Socket[] = [];
  const timers = new Set<unknown>();
  class Socket {
    readyState = 0;
    binaryType = "";
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number; wasClean: boolean }) => void) | null = null;
    onerror: (() => void) | null = null;
    send = vi.fn();
    close = vi.fn(() => { this.readyState = 3; });
    constructor() { sockets.push(this); }
  }
  const window = {
    __liloVoiceCfg: { token: "test", org: "test-org", instructions: "" },
    __TAURI_INTERNALS__: { invoke: vi.fn(async () => {}) },
    __liloClaudeVoice: null as { stop: () => void; sendPcm: (chunk: string) => void } | null,
  };
  const fetch = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => ({ uuid: "test-conversation" }) }));
  const context = {
    window, fetch, WebSocket: Socket, crypto, AbortController, URLSearchParams,
    TextDecoder, Uint8Array, Intl, performance, console, atob, btoa,
    setInterval: (callback: unknown) => { timers.add(callback); return callback; },
    clearInterval: (id: unknown) => { timers.delete(id); },
    setTimeout: (callback: unknown) => { timers.add(callback); return callback; },
    clearTimeout: (id: unknown) => { timers.delete(id); },
  };
  const run = () => new Function(...Object.keys(context), engine)(...Object.values(context));
  const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
  return { window, fetch, sockets, timers, run, flush };
}

describe("Claude voice engine teardown", () => {
  it("can stop while creating the conversation without opening a late socket", async () => {
    const h = harness();
    let finish!: (response: { ok: boolean; json: () => Promise<{ uuid: string }> }) => void;
    h.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    h.run();
    const pending = h.fetch.mock.calls[0];
    expect(h.window.__liloClaudeVoice).not.toBeNull();
    h.window.__liloClaudeVoice?.stop();
    expect(pending[1].signal?.aborted).toBe(true);
    finish({ ok: true, json: async () => ({ uuid: "late" }) });
    await h.flush();
    expect(h.sockets).toHaveLength(0);
    expect(h.timers.size).toBe(0);
  });

  it("closes the socket and timers and ignores queued events after stopping", async () => {
    const h = harness();
    h.run();
    await h.flush();
    const ws = h.sockets[0];
    const opened = ws.onopen;
    ws.readyState = 1;
    opened?.();
    expect(h.timers.size).toBeGreaterThan(0);
    h.window.__liloClaudeVoice?.stop();
    const sent = ws.send.mock.calls.length;
    opened?.();
    h.window.__liloClaudeVoice?.sendPcm("AAA=");
    expect(ws.close).toHaveBeenCalledOnce();
    expect(ws.send).toHaveBeenCalledTimes(sent);
    expect(h.timers.size).toBe(0);
  });

  it("aborts a pending instruction request and clears its timeout on hang-up", async () => {
    const h = harness();
    h.window.__liloVoiceCfg.instructions = "Keep replies concise.";
    h.fetch.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ uuid: "test-conversation" }) }));
    h.fetch.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    h.run();
    await h.flush();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.timers.size).toBeGreaterThan(0);
    h.window.__liloClaudeVoice?.stop();
    await h.flush();
    expect(h.fetch.mock.calls[1][1].signal?.aborted).toBe(true);
    expect(h.timers.size).toBe(0);
    expect(h.sockets).toHaveLength(0);
  });
});
