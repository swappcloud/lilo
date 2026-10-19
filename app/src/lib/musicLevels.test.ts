import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ read: vi.fn(), visibility: (_visible: boolean) => {} }));
vi.mock("./gateway", () => ({ isTauri: () => true, mediaLevels: backend.read }));
vi.mock("./log", () => ({ log: () => {} }));
vi.mock("../shared/lib/visibleRaf", () => ({
  watchWindowVisibility: (listener: (visible: boolean) => void) => {
    backend.visibility = listener;
    listener(true);
    return () => { backend.visibility = () => {}; };
  },
}));

import { musicLevels, startMusicLevels, stopMusicLevels } from "./musicLevels";

describe("music level polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    backend.read.mockReset().mockResolvedValue({ level: 0.4, low: 0.3, high: 0.2 });
  });
  afterEach(() => { stopMusicLevels(); vi.useRealTimers(); });

  it("pauses visual readings while hidden and reads immediately on return", async () => {
    startMusicLevels();
    await vi.advanceTimersByTimeAsync(100);
    expect(musicLevels()?.level).toBe(0.4);
    backend.visibility(false);
    const calls = backend.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(backend.read).toHaveBeenCalledTimes(calls);
    expect(musicLevels()).toBeNull();
    backend.visibility(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.read).toHaveBeenCalledTimes(calls + 1);
    expect(musicLevels()?.level).toBe(0.4);
  });

  it("ignores a late reading from a stopped poller after restarting", async () => {
    let finish!: (levels: { level: number; low: number; high: number }) => void;
    backend.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    startMusicLevels();
    stopMusicLevels();
    startMusicLevels();
    await vi.advanceTimersByTimeAsync(0);
    finish({ level: 0.9, low: 0.9, high: 0.9 });
    await vi.advanceTimersByTimeAsync(0);
    expect(musicLevels()?.level).toBe(0.4);
    await vi.advanceTimersByTimeAsync(50);
    expect(backend.read).toHaveBeenCalledTimes(3);
  });

  it("ignores a late reading from before hiding the window", async () => {
    let finish!: (levels: { level: number; low: number; high: number }) => void;
    backend.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    startMusicLevels();
    backend.visibility(false);
    finish({ level: 0.9, low: 0.9, high: 0.9 });
    await vi.advanceTimersByTimeAsync(100);
    expect(musicLevels()).toBeNull();
    expect(backend.read).toHaveBeenCalledTimes(1);
  });
});
