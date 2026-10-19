import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/gateway", async (original) => ({
  ...(await original<typeof import("../lib/gateway")>()),
  isTauri: () => false,
}));

import { handleNotify, type NotifyHost } from "./pluginNotify";

function host(canSpeak: boolean) {
  const calls = { toast: [] as string[], chime: 0, hidden: [] as string[] };
  const fake: NotifyHost = {
    toast: (text) => calls.toast.push(text),
    chime: () => {
      calls.chime += 1;
    },
    canSpeak: () => canSpeak,
    sendHidden: (text) => calls.hidden.push(text),
  };
  return { fake, calls };
}

const event = (topic: string, payload: unknown) => ({ topic, payload, source: "com.lilo.pomodoro" });

describe("plugin notifications", () => {
  it("toasts and chimes, and stays quiet to the model outside a live call", () => {
    const { fake, calls } = host(false);
    expect(handleNotify(fake, event("notify", { summary: "Focus done — take 5." }))).toBe(true);
    expect(calls.toast).toEqual(["Focus done — take 5."]);
    expect(calls.chime).toBe(1);
    expect(calls.hidden).toEqual([]);
  });

  it("asks the assistant to say it during a live call", () => {
    const { fake, calls } = host(true);
    handleNotify(fake, event("notify", { summary: "Break over." }));
    expect(calls.hidden).toHaveLength(1);
    expect(calls.hidden[0]).toContain("Break over.");
  });

  it("respects a plugin that asks for no chime and no speech", () => {
    const { fake, calls } = host(true);
    handleNotify(fake, event("notify", { summary: "Saved.", chime: false, speak: false }));
    expect(calls.chime).toBe(0);
    expect(calls.hidden).toEqual([]);
  });

  it("ignores other topics and empty or oversized noise", () => {
    const { fake, calls } = host(true);
    expect(handleNotify(fake, event("location.changed", { summary: "x" }))).toBe(false);
    expect(handleNotify(fake, event("notify", { summary: "   " }))).toBe(false);
    handleNotify(fake, event("notify", { summary: "a\n\n".repeat(400) }));
    expect(calls.toast).toHaveLength(1);
    expect(calls.toast[0].length).toBeLessThanOrEqual(300);
    expect(calls.toast[0]).not.toContain("\n");
  });
});
