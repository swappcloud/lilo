import { describe, expect, it } from "vitest";

import { formatDuration } from "./format";

describe("formatDuration", () => {
  it("reads as m:ss under an hour and h:mm:ss past it", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9)).toBe("0:09");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(59 * 60 + 59)).toBe("59:59");
    expect(formatDuration(3661)).toBe("1:01:01");
  });

  it("never shows a negative clock", () => {
    expect(formatDuration(-4)).toBe("0:00");
  });
});
