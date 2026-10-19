import { describe, expect, it } from "vitest";

import { bubbleSide, holdMs } from "./geometry";

describe("bubbleSide", () => {
  it("prefers the right when it fits", () => {
    expect(bubbleSide({ left: 900, right: 400 })).toBe("right");
  });

  it("goes left when only the left fits", () => {
    expect(bubbleSide({ left: 500, right: 180 })).toBe("left");
  });

  it("takes the roomier side when neither fits", () => {
    expect(bubbleSide({ left: 300, right: 250 })).toBe("left");
    expect(bubbleSide({ left: 250, right: 300 })).toBe("right");
  });

  it("defaults to the right before the space is known", () => {
    expect(bubbleSide(null)).toBe("right");
  });
});

describe("holdMs", () => {
  it("grows with the reply and stays within bounds", () => {
    expect(holdMs("ok")).toBe(3_000);
    expect(holdMs("x".repeat(100))).toBe(5_700);
    expect(holdMs("x".repeat(1_000))).toBe(9_000);
  });
});
