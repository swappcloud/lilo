import { describe, expect, it } from "vitest";

import { renderStatus } from "./statusbarStore";

const item = (endsAt: number | null, left: number | null) => ({
  source: "com.lilo.pomodoro",
  label: "Focus",
  endsAt,
  left,
  actions: [],
});

describe("status bar rendering", () => {
  it("counts down to the end and never below zero", () => {
    expect(renderStatus(item(1_000 + 25 * 60, null), 1_000)).toBe("Focus 25:00");
    expect(renderStatus(item(1_000 + 61, null), 1_000)).toBe("Focus 01:01");
    expect(renderStatus(item(1_000, null), 9_000)).toBe("Focus 00:00");
    expect(renderStatus(item(3_700, null), 0)).toBe("Focus 1:01:40");
  });

  it("shows the time a paused item has left, and a plain label as is", () => {
    expect(renderStatus(item(null, 754), 123)).toBe("Focus 12:34");
    expect(renderStatus(item(null, null), 0)).toBe("Focus");
  });
});
