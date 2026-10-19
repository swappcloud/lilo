import { describe, expect, it } from "vitest";

import { GazeMotion, minimumJerk, saccadeDuration } from "./gazeMotion";

const FRAME = 1000 / 60;

/** Step at 60 fps towards a fixed target; returns the eye x per frame. */
function track(eyes: GazeMotion, ms: number, x: number, y = 0, from = 1000) {
  const xs: number[] = [];
  let now = from;
  for (let i = 0; i < Math.round(ms / FRAME); i += 1) {
    now += FRAME;
    eyes.step(now, x, y);
    xs.push(eyes.x);
  }
  return { xs, now };
}

describe("minimumJerk", () => {
  it("starts and ends at rest, fastest in the middle", () => {
    expect(minimumJerk(0)).toBe(0);
    expect(minimumJerk(1)).toBe(1);
    expect(minimumJerk(0.5)).toBeCloseTo(0.5);
    expect(minimumJerk(0.1)).toBeLessThan(0.02);
  });

  it("makes bigger jumps take longer", () => {
    expect(saccadeDuration(20)).toBeGreaterThan(saccadeDuration(2));
    expect(saccadeDuration(22)).toBeLessThan(90);
  });
});

describe("GazeMotion", () => {
  it("jumps to a far target quickly instead of gliding", () => {
    const eyes = new GazeMotion(() => 0.5);
    const { xs } = track(eyes, 250, 20);
    // Nothing happens during the reaction time...
    expect(xs[1]).toBeCloseTo(0, 1);
    // ...then most of the way is covered within a few frames.
    const covered = xs.findIndex((x) => x > 15);
    expect(covered).toBeGreaterThan(2);
    expect(covered).toBeLessThan(10);
    // A big jump lands short, and a correction finishes it.
    expect(Math.abs(xs[xs.length - 1] - 20)).toBeLessThan(2);
  });

  it("follows a slowly moving target smoothly", () => {
    const eyes = new GazeMotion(() => 0.99);
    let now = 1000;
    let maxStep = 0;
    let previous = 0;
    for (let i = 0; i < 120; i += 1) {
      now += FRAME;
      eyes.step(now, i * 0.05, 0);
      maxStep = Math.max(maxStep, Math.abs(eyes.x - previous));
      previous = eyes.x;
    }
    expect(Math.abs(eyes.x - 119 * 0.05)).toBeLessThan(1.5);
    expect(maxStep).toBeLessThan(1.5);
  });

  it("turns the head after the eyes", () => {
    const eyes = new GazeMotion(() => 0.5);
    track(eyes, 120, 20);
    expect(eyes.headX).toBeLessThan(eyes.x * 0.5);
    track(eyes, 1500, 20, 1120);
    expect(eyes.headX).toBeGreaterThan(17);
  });

  it("never quite freezes while fixating", () => {
    const eyes = new GazeMotion(() => 0.3);
    eyes.settle(5, 0);
    const { xs } = track(eyes, 3000, 5);
    expect(new Set(xs.map((x) => x.toFixed(2))).size).toBeGreaterThan(1);
    expect(xs.every((x) => Math.abs(x - 5) < 2)).toBe(true);
  });

  it("is steady across frame rates", () => {
    const fast = new GazeMotion(() => 0.5);
    const slow = new GazeMotion(() => 0.5);
    for (let t = 1000; t <= 1600; t += 1000 / 120) fast.step(t, 12, 4);
    for (let t = 1000; t <= 1600; t += 1000 / 30) slow.step(t, 12, 4);
    expect(Math.abs(fast.x - slow.x)).toBeLessThan(1.5);
  });
});
