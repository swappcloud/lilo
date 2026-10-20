import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalVoiceController, isLocalVoiceTranscript } from "./localVoice";

const transcript = (text: string, isFinal: boolean, turnId = "turn-1") => ({
  version: 1 as const,
  turnId,
  text,
  isFinal,
});

describe("LocalVoiceController", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects malformed and oversized envelopes", () => {
    expect(isLocalVoiceTranscript(transcript("stop music", true))).toBe(true);
    expect(isLocalVoiceTranscript({ ...transcript(" ", true) })).toBe(false);
    expect(isLocalVoiceTranscript({ ...transcript("stop", true), version: 2 })).toBe(false);
    expect(isLocalVoiceTranscript({ ...transcript("stop", true), isFinal: 1 })).toBe(false);
    expect(isLocalVoiceTranscript(transcript("x".repeat(8193), true))).toBe(false);
  });

  it("settles the latest partial after 900 ms and suppresses its matching final", () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    const controller = new LocalVoiceController(dispatch, () => true);
    controller.push(transcript("stop", false));
    vi.advanceTimersByTime(600);
    controller.push(transcript("stop music", false));
    vi.advanceTimersByTime(899);
    expect(dispatch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenLastCalledWith(transcript("stop music", true));
    controller.push(transcript("stop music", true));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("routes finals immediately and allows a later repeated utterance on a reused task id", () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    const controller = new LocalVoiceController(dispatch, () => true);
    controller.push(transcript("stop music", true));
    expect(dispatch).toHaveBeenCalledTimes(1);
    controller.push(transcript("stop music", true));
    expect(dispatch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_501);
    controller.push(transcript("stop music", true));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0].turnId).not.toBe(dispatch.mock.calls[1][0].turnId);
  });

  it("cancels pending partials when wake is disabled or the provider becomes active", () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    let canRoute = true;
    const controller = new LocalVoiceController(dispatch, () => canRoute);
    controller.push(transcript("stop music", false));
    canRoute = false;
    controller.push(transcript("anything", false));
    vi.advanceTimersByTime(1_000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(controller.push(transcript("stop music", true))).toBe(false);
  });

  it("keeps one utterance id through partial revisions and accepts a changed final", () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    const controller = new LocalVoiceController(dispatch, () => true);
    controller.push(transcript("play", false));
    controller.push(transcript("play jazz", true));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toEqual(transcript("play jazz", true));
  });
});
