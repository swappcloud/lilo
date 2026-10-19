import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PendingNotes } from "./pendingNotes";

describe("PendingNotes", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drops the note when the result arrives first", () => {
    const send = vi.fn();
    const notes = new PendingNotes(send, 1000);
    notes.hold("weather.mood", "[LILO] running weather.mood");
    notes.settle("weather.mood");
    vi.advanceTimersByTime(2000);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the note when the result is slow", () => {
    const send = vi.fn();
    const notes = new PendingNotes(send, 1000);
    notes.hold("media.play", "[LILO] running media.play");
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledWith("[LILO] running media.play");
    notes.settle("media.play");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
