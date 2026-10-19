import { describe, expect, it } from "vitest";

import { toScene } from "./sceneStore";

describe("toScene", () => {
  it("accepts the vocabulary and clamps intensity", () => {
    expect(toScene({ kind: "rain", intensity: 3, night: true })).toEqual({
      kind: "rain",
      intensity: 1,
      night: true,
    });
    expect(toScene({ kind: "snow" })).toEqual({ kind: "snow", intensity: 0.6, night: false });
  });

  it("draws nothing for anything outside it", () => {
    expect(toScene({ kind: "<script>" })).toBeNull();
    expect(toScene("rain")).toBeNull();
    expect(toScene(null)).toBeNull();
    expect(toScene({ kind: "rain", intensity: Number.NaN })?.intensity).toBe(0.6);
  });
});
