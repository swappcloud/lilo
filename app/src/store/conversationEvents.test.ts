import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationEvents } from "./conversationEvents";
import type { TranscriptTurn } from "../types";

function turn(text: string, speaker: TranscriptTurn["speaker"] = "user"): TranscriptTurn {
  return { id: "turn-1", speaker, text, timestamp: 1, final: false };
}
afterEach(() => vi.useRealTimers());

describe("conversation events", () => {
  it("preserves the first observed time when a caption is revised after a question", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const publish = vi.fn().mockResolvedValue(undefined);
    const events = new ConversationEvents("session-1", publish, () => false, vi.fn());
    events.caption(turn("Start a study routine"));
    await events.flush();
    vi.setSystemTime(5_000);
    events.caption({...turn("Start a study routine for fifteen minutes"), final:true});
    await events.flush();
    expect(publish.mock.calls[0][1].firstSeenAt).toBe(1_000);
    expect(publish.mock.calls[1][1].firstSeenAt).toBe(1_000);
    expect(publish.mock.calls[1][1].at).toBe(5_000);
    await events.close();
  });
  it("coalesces caption revisions and flushes them before ending the session", async () => {
    vi.useFakeTimers();
    const publish = vi.fn().mockResolvedValue(undefined);
    const events = new ConversationEvents("session-1", publish, () => false, vi.fn());
    events.caption(turn("I want"));
    events.caption(turn("I want to practice Italian"));
    expect(publish).not.toHaveBeenCalled();
    await events.close();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0]).toEqual(["conversation.turn", expect.objectContaining({
      sessionId: "session-1", turn: expect.objectContaining({text: "I want to practice Italian"}),
    })]);
    expect(publish.mock.calls[1][0]).toBe("conversation.ended");
    await vi.runAllTimersAsync();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("never publishes injected, status, system or post-session turns", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const events = new ConversationEvents("session-1", publish, (text) => text === "Injected prompt", vi.fn());
    events.caption(turn("Injected prompt"));
    events.caption(turn("[LILO] app status"));
    events.caption(turn("System", "system"));
    events.caption(turn(" "));
    await events.close();
    events.caption(turn("Too late"));
    await events.close();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toBe("conversation.ended");
  });

  it("continues the event queue after a failed publication", async () => {
    const publish = vi.fn().mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue(undefined);
    const report = vi.fn();
    const events = new ConversationEvents("session-1", publish, () => false, report);
    events.caption(turn("Practice"));
    await events.close();
    expect(report).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
