import { describe, expect, it } from "vitest";

import { musicBinsFrom } from "./orbRenderer";

const empty = () => new Array<number>(28).fill(0);

describe("musicBinsFrom", () => {
  it("puts the bass and the treble where the player says they are", () => {
    const bass = musicBinsFrom({ level: 0.8, low: 0.9, high: 0.05 }, empty(), 1);
    const treble = musicBinsFrom({ level: 0.8, low: 0.05, high: 0.9 }, empty(), 1);
    expect(bass[0]).toBeGreaterThan(bass[27]);
    expect(treble[27]).toBeGreaterThan(treble[0]);
    expect(bass[0]).toBeGreaterThan(treble[0]);
    expect(treble[27]).toBeGreaterThan(bass[27]);
  });

  it("clamps whatever the player reports", () => {
    const bins = musicBinsFrom({ level: 2, low: 3, high: -1 }, empty(), 0.4);
    for (const value of bins) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
