import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProvider, providerMeta } from "../index";
import { MockVoiceProvider } from "./mockProvider";
import type { TranscriptTurn } from "../../types";

async function connectMock(provider: MockVoiceProvider): Promise<void> {
  const promise = provider.connect({ settings: { voice: "cove" } });
  await vi.runAllTimersAsync();
  await promise;
}

describe("provider factory", () => {
  it("creates each provider with the right id", () => {
    expect(createProvider("mock").id).toBe("mock");
    expect(createProvider("chatgpt-web").id).toBe("chatgpt-web");
  });

  it("maps meta for known providers", () => {
    expect(providerMeta("mock").requiresAccount).toBe(false);
    expect(providerMeta("chatgpt-web").requiresAccount).toBe(true);
  });
});

describe("MockVoiceProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits connecting then connected", async () => {
    const provider = new MockVoiceProvider({ tickMs: 1 });
    const states: string[] = [];
    provider.onState((state) => states.push(state));
    await connectMock(provider);
    expect(states[0]).toBe("connecting");
    expect(states).toContain("connected");
  });

  it("streams a partial then final assistant reply", async () => {
    const provider = new MockVoiceProvider({ tickMs: 1 });
    const captions: TranscriptTurn[] = [];
    provider.onCaption((turn) => captions.push(turn));
    await connectMock(provider);
    captions.length = 0;

    provider.sendText("hello there");
    await vi.runAllTimersAsync();

    const assistant = captions.filter((t) => t.speaker === "assistant");
    expect(assistant.length).toBeGreaterThan(1);
    expect(assistant.some((t) => !t.final)).toBe(true);
    expect(assistant[assistant.length - 1].final).toBe(true);
    expect(assistant[assistant.length - 1].text).toContain("hello there");
  });

  it("onResponse only fires for assistant turns", async () => {
    const provider = new MockVoiceProvider({ tickMs: 1 });
    const speakers: string[] = [];
    provider.onResponse((turn) => speakers.push(turn.speaker));
    await connectMock(provider);
    provider.sendText("hi");
    await vi.runAllTimersAsync();
    expect(speakers.length).toBeGreaterThan(0);
    expect(speakers.every((s) => s === "assistant")).toBe(true);
  });

  it("interrupt emits an Interrupted system turn and stops speaking", async () => {
    const provider = new MockVoiceProvider({ tickMs: 10 });
    const captions: TranscriptTurn[] = [];
    provider.onCaption((turn) => captions.push(turn));
    await connectMock(provider);

    provider.sendText("tell me a long story");
    await vi.advanceTimersByTimeAsync(25);
    provider.interrupt();

    expect(
      captions.some((t) => t.speaker === "system" && /Interrupted/.test(t.text)),
    ).toBe(true);

    const countAfterInterrupt = captions.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(captions.length).toBe(countAfterInterrupt);
  });

  it("invokes the time tool when asked", async () => {
    const runTool = vi.fn().mockResolvedValue({
      formatted: "2026-01-01 09:30:00 UTC",
      timezone: "UTC",
    });
    const provider = new MockVoiceProvider({ tickMs: 1, runTool });
    const captions: TranscriptTurn[] = [];
    provider.onCaption((turn) => captions.push(turn));
    await connectMock(provider);
    captions.length = 0;

    provider.sendText("what time is it?");
    await vi.runAllTimersAsync();

    expect(runTool).toHaveBeenCalledWith("get_current_time", { timezone: "" });
    const assistantText = captions
      .filter((t) => t.speaker === "assistant")
      .map((t) => t.text)
      .join("");
    expect(assistantText).toContain("2026-01-01 09:30:00 UTC");
  });

  it("invokes the web search tool when asked", async () => {
    const runTool = vi
      .fn()
      .mockResolvedValue([
        { title: "Eiffel Tower", url: "https://x", snippet: "The Eiffel Tower is in Paris." },
      ]);
    const provider = new MockVoiceProvider({ tickMs: 1, runTool });
    const captions: TranscriptTurn[] = [];
    provider.onCaption((turn) => captions.push(turn));
    await connectMock(provider);
    captions.length = 0;

    provider.sendText("search eiffel tower");
    await vi.runAllTimersAsync();

    expect(runTool).toHaveBeenCalledWith("web_search", {
      query: "eiffel tower",
      max_results: 3,
    });
    const assistantText = captions
      .filter((t) => t.speaker === "assistant")
      .map((t) => t.text)
      .join("");
    expect(assistantText).toContain("Eiffel Tower is in Paris");
  });

  it("disconnect emits disconnected", async () => {
    const provider = new MockVoiceProvider({ tickMs: 1 });
    const states: string[] = [];
    provider.onState((state) => states.push(state));
    await connectMock(provider);
    const promise = provider.disconnect();
    await vi.runAllTimersAsync();
    await promise;
    expect(states[states.length - 1]).toBe("disconnected");
  });
});