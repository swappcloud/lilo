import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The music drive, end to end through React: the stage must follow the levels
 * the player reports, not just its own idle pulse. This is the seam that broke
 * twice in the app (the face frozen while a track was clearly playing), so it
 * gets a test of its own.
 */

let current = { level: 0.05, low: 0.04, high: 0.02 };

vi.mock("../../../lib/gateway", () => ({
  isTauri: () => true,
  mediaLevels: async () => current,
  onMood: async () => () => {},
}));

vi.mock("../../../store/moodContext", () => ({
  watchConversationMood: () => () => {},
}));

import { musicLevels, startMusicLevels, stopMusicLevels } from "../../../lib/musicLevels";
import { LiloStage } from "./LiloStage";

let frames: Array<(time: number) => void> = [];
let container: HTMLDivElement;
let root: Root;
let clock = 1_000;

beforeEach(() => {
  frames = [];
  clock = 1_000;
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  stopMusicLevels();
  vi.unstubAllGlobals();
});

/** Mount the stage the way `VoiceStage` does. */
function mountStage(): void {
  act(() => {
    root = createRoot(container);
    root.render(
      <LiloStage
        phase="listening"
        animations
        music
        accent={[
          [99, 102, 241],
          [168, 85, 247],
        ]}
      />,
    );
  });
}

/** Run the queued animation frames with advancing timestamps. */
function runFrames(count: number): void {
  for (let i = 0; i < count; i += 1) {
    clock += 16;
    const queued = frames;
    frames = [];
    act(() => {
      for (const callback of queued) callback(clock);
    });
  }
}

/** Point the mocked player at a loudness and let the poller pick it up. */
async function setLevels(level: number): Promise<void> {
  current = { level, low: level * 0.9, high: level * 0.4 };
  stopMusicLevels();
  startMusicLevels();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Height of the listening waveform, in viewBox units. */
function waveHeight(): number {
  const path = container.querySelector('[data-lilo="wave"]')?.getAttribute("d") ?? "";
  const ys = path
    .match(/-?\d+(\.\d+)?,-?\d+(\.\d+)?/g)!
    .map((pair) => Number(pair.split(",")[1]));
  return Math.max(...ys) - Math.min(...ys);
}

describe("the LILO stage follows the music", () => {
  it("grows the waveform with the track's loudness", async () => {
    mountStage();
    await setLevels(0.05);
    runFrames(60);
    const quiet = waveHeight();

    await setLevels(0.95);
    runFrames(60);
    const loud = waveHeight();

    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet * 1.8);
  });

  it("keeps the levels fresh while a track plays", async () => {
    await setLevels(0.6);
    expect(musicLevels()?.level).toBeCloseTo(0.6);
    // Nothing is draining the poller: the reading stays fresh long enough for
    // a frame to use it.
    expect(musicLevels()).not.toBeNull();
  });

  it("paints a listening mouth, not the speaking one, while the mic is off", async () => {
    mountStage();
    await setLevels(0.7);
    runFrames(30);
    const wave = container.querySelector('[data-lilo="wave"]');
    const mouth = container.querySelector('[data-lilo="mouth"]');
    expect(Number(wave?.getAttribute("opacity"))).toBeGreaterThan(0.9);
    expect(Number(mouth?.getAttribute("opacity"))).toBeLessThan(0.1);
  });
});
