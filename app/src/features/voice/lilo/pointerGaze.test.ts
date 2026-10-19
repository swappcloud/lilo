import { describe, expect, it } from "vitest";

import { aimGaze, pointerGaze } from "./pointerGaze";

describe("aimGaze", () => {
  it("is zero at the centre", () => {
    expect(aimGaze(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("keeps the pointer's direction", () => {
    const aim = aimGaze(0.3, -0.4);
    expect(aim.y / aim.x).toBeCloseTo(-0.4 / 0.3);
  });

  it("turns early for everyday moves and saturates softly far out", () => {
    expect(aimGaze(0.3, 0).x).toBeGreaterThan(0.3);
    expect(aimGaze(1, 0).x).toBeLessThan(1);
    expect(aimGaze(1, 0).x).toBeGreaterThan(aimGaze(0.6, 0).x);
    expect(aimGaze(40, 0).x).toBe(1);
  });

  it("reaches no farther in a corner than at the side", () => {
    const corner = aimGaze(-30, 30);
    expect(Math.hypot(corner.x, corner.y)).toBeCloseTo(1);
  });

  it("releases the gaze when the pointer has been still for a while", () => {
    expect(pointerGaze(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});
