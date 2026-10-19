import { describe, expect, it, vi } from "vitest";
import { CaptionPersistence } from "./captionPersistence";

describe("caption persistence", () => {
  it("keeps storage off the caption path without starving saves during continuous speech", () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn();
      const persistence = new CaptionPersistence(write);
      for (let i = 0; i < 5; i++) {
        persistence.schedule();
        expect(write).not.toHaveBeenCalled();
        vi.advanceTimersByTime(50);
      }
      expect(write).toHaveBeenCalledOnce();
      persistence.schedule();
      vi.advanceTimersByTime(250);
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes immediately on shutdown and cancels the pending save", () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn();
      const persistence = new CaptionPersistence(write);
      persistence.schedule();
      persistence.flush();
      vi.advanceTimersByTime(1000);
      expect(write).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
