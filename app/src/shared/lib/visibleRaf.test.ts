import { afterEach, describe, expect, it, vi } from "vitest";

import { runVisibleAnimationLoop } from "./visibleRaf";

const native = vi.hoisted(() => ({ visible: true, minimized: false, focus: () => {} }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isVisible: async () => native.visible,
    isMinimized: async () => native.minimized,
    onFocusChanged: (callback: () => void) => { native.focus = callback; },
    onResized: () => {},
  }),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Drives the loop by hand: jsdom has no real frames. */
function fakeFrames() {
  const scheduled = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  let cancelled = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextId++;
    scheduled.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    cancelled += 1;
    scheduled.delete(id);
  });
  return {
    pending: () => scheduled.size,
    cancelled: () => cancelled,
    runNext(now: number) {
      const [id, callback] = [...scheduled.entries()][0] ?? [];
      if (callback === undefined) throw new Error("no frame scheduled");
      scheduled.delete(id);
      callback(now);
    },
  };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("runVisibleAnimationLoop", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    native.visible = true;
    native.minimized = false;
    setHidden(false);
    await flush();
  });

  it("pauses for a natively hidden window even if the document remains visible", async () => {
    const frames = fakeFrames();
    const stop = runVisibleAnimationLoop(() => true);
    await flush();
    native.visible = false;
    native.focus();
    await flush();
    expect(document.hidden).toBe(false);
    expect(frames.pending()).toBe(0);
    expect(document.documentElement.dataset.windowHidden).toBe("true");
    native.visible = true;
    native.focus();
    await flush();
    expect(frames.pending()).toBe(1);
    stop();
  });

  it("does not revive an exhausted animation after hiding and showing", async () => {
    const frames = fakeFrames();
    const stop = runVisibleAnimationLoop(() => false);
    frames.runNext(0);
    setHidden(true);
    await flush();
    setHidden(false);
    await flush();
    expect(frames.pending()).toBe(0);
    stop();
  });

  it("draws on the requested cadence, not on every frame", () => {
    const frames = fakeFrames();
    let drawn = 0;
    const stop = runVisibleAnimationLoop(() => {
      drawn += 1;
      return true;
    }, { fps: 30 });

    frames.runNext(0); // first frame draws
    frames.runNext(10); // early: skipped
    frames.runNext(40);
    expect(drawn).toBe(2);

    stop();
  });

  it("stops when the window is hidden and resumes when it is back", async () => {
    const frames = fakeFrames();
    let drawn = 0;
    const stop = runVisibleAnimationLoop(() => {
      drawn += 1;
      return true;
    }, { fps: 60 });
    frames.runNext(0);
    expect(drawn).toBe(1);

    setHidden(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames.pending()).toBe(0);

    setHidden(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames.pending()).toBe(1);
    frames.runNext(100);
    expect(drawn).toBe(2);

    stop();
  });

  it("stops for good when the frame asks to", () => {
    const frames = fakeFrames();
    let drawn = 0;
    const stop = runVisibleAnimationLoop(() => {
      drawn += 1;
      return false;
    });
    frames.runNext(0);
    expect(drawn).toBe(1);
    expect(frames.pending()).toBe(0);

    stop();
  });
});
