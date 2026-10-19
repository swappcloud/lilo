import { describe, expect, it, vi } from "vitest";
import { IdleDeadline, startSessionIdleWatch } from "./sessionIdle";

import { DEFAULTS, normalizeIdleTimeout, usePreferencesStore } from "./preferencesStore";
import { useSessionStore } from "./sessionStore";

describe("conversation inactivity", () => {
  it("defaults to 30 and bounds stored or edited values", () => {
    expect(DEFAULTS.idleTimeoutSeconds).toBe(30);
    expect(normalizeIdleTimeout(undefined)).toBe(30);
    expect(normalizeIdleTimeout(NaN)).toBe(30);
    expect(normalizeIdleTimeout(-1)).toBe(0);
    expect(normalizeIdleTimeout(9.9)).toBe(9);
    expect(normalizeIdleTimeout(9999)).toBe(3600);
  });
  it("disconnects through the session owner and disposes its timer", async () => {
    vi.useFakeTimers();
    const session = useSessionStore.getState();
    const preferences = usePreferencesStore.getState();
    const disconnect = vi.fn(async () => {
      useSessionStore.setState({ connectionState: "idle" });
    });
    usePreferencesStore.setState({ idleTimeoutSeconds: 30 });
    useSessionStore.setState({ connectionState: "connected", assistantSpeaking: false, micLevel: 0, outputLevel: 0, disconnect });
    const stop = startSessionIdleWatch();
    try {
      await vi.advanceTimersByTimeAsync(29_000);
      window.dispatchEvent(new Event("keydown"));
      await vi.advanceTimersByTimeAsync(29_000);
      expect(disconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(disconnect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(disconnect).toHaveBeenCalledTimes(1);
      stop();
      useSessionStore.setState({ connectionState: "connected" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      useSessionStore.setState(session);
      usePreferencesStore.setState(preferences);
      vi.useRealTimers();
    }
  });
  it("expires after 30 seconds of quiet, only once", () => {
    const idle = new IdleDeadline();
    expect(idle.check(0, true, false, 30)).toBe(false);
    expect(idle.check(29_999, true, false, 30)).toBe(false);
    expect(idle.check(30_000, true, false, 30)).toBe(true);
    expect(idle.check(31_000, true, false, 30)).toBe(false);
  });
  it("holds while speaking and restarts the quiet interval afterwards", () => {
    const idle = new IdleDeadline();
    idle.check(0, true, false, 30);
    expect(idle.check(50_000, true, true, 30)).toBe(false);
    expect(idle.check(60_000, true, false, 30)).toBe(false);
    expect(idle.check(80_000, true, false, 30)).toBe(true);
  });
  it("resets on captions or interface activity", () => {
    const idle = new IdleDeadline();
    idle.check(0, true, false, 30);
    idle.activity(20_000);
    expect(idle.check(49_999, true, false, 30)).toBe(false);
    expect(idle.check(50_000, true, false, 30)).toBe(true);
  });
  it("does not time out a disabled or connecting session", () => {
    const idle = new IdleDeadline();
    expect(idle.check(0, false, false, 30)).toBe(false);
    expect(idle.check(100_000, false, false, 30)).toBe(false);
    expect(idle.check(100_000, true, false, 0)).toBe(false);
    expect(idle.check(200_000, true, false, 0)).toBe(false);
    expect(idle.check(200_000, true, false, 30)).toBe(false);
    expect(idle.check(230_000, true, false, 30)).toBe(true);
  });
  it("starts a fresh interval after a preference change or new conversation", () => {
    const idle = new IdleDeadline();
    idle.check(0, true, false, 30);
    expect(idle.check(25_000, true, false, 10)).toBe(false);
    expect(idle.check(35_000, true, false, 10)).toBe(true);
    idle.check(40_000, false, false, 10);
    expect(idle.check(50_000, true, false, 10)).toBe(false);
    expect(idle.check(60_000, true, false, 10)).toBe(true);
  });
});
