import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/gateway", () => ({ onMood: async () => () => {} }));

import { showMood, useMoodStore } from "./moodStore";

describe("showMood", () => {
  afterEach(() => {
    showMood("neutral", "asked");
    vi.useRealTimers();
  });

  it("fades a conversation reaction back on its own", () => {
    vi.useFakeTimers();
    showMood("happy", "context");
    expect(useMoodStore.getState().mood).toBe("happy");
    vi.advanceTimersByTime(4_000);
    expect(useMoodStore.getState().mood).toBeNull();
  });

  it("never lets the conversation override an asked-for expression", () => {
    vi.useFakeTimers();
    showMood("angry", "asked");
    showMood("happy", "context");
    expect(useMoodStore.getState().mood).toBe("angry");
    vi.advanceTimersByTime(5_000);
    showMood("happy", "context");
    expect(useMoodStore.getState().mood).toBe("happy");
  });
});
