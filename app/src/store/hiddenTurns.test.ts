import { describe, expect, it } from "vitest";

import { HiddenTurns, normalizeHidden } from "./hiddenTurns";

const PERSONA =
  "You are LILO — Listen In. Listen Out. — my realtime voice assistant.";

describe("normalizeHidden", () => {
  it("folds case, punctuation and whitespace", () => {
    expect(normalizeHidden("  Hello,   LILO!  ")).toBe("hello lilo");
    expect(normalizeHidden("end-call (End the live conversation)")).toBe(
      "end call end the live conversation",
    );
  });
});

describe("HiddenTurns", () => {
  it("recognises an exact echo and consumes it", () => {
    const turns = new HiddenTurns();
    turns.remember(PERSONA);
    expect(turns.matches(PERSONA)).toBe(true);
    // After the last piece arrives it is no longer pending.
    expect(turns.matches(PERSONA)).toBe(false);
  });

  it("ignores punctuation and spacing differences in the echo", () => {
    const turns = new HiddenTurns();
    turns.remember(PERSONA);
    expect(turns.matches("you are lilo listen in listen out my realtime voice assistant")).toBe(
      true,
    );
  });

  it("recognises streamed deltas as still ours", () => {
    const turns = new HiddenTurns();
    turns.remember(PERSONA);
    // Captions are cumulative: each delta is a longer prefix of the whole.
    expect(turns.matches("You are LILO — Listen In.")).toBe(true);
    // A partial must not consume the entry: the rest is still coming.
    expect(turns.matches(PERSONA)).toBe(true);
  });

  it("never swallows a real user utterance", () => {
    const turns = new HiddenTurns();
    turns.remember(PERSONA);
    expect(turns.matches("play bohemian rhapsody")).toBe(false);
    expect(turns.matches("")).toBe(false);
    expect(turns.matches("...")).toBe(false);
  });

  it("forgets everything when cleared", () => {
    const turns = new HiddenTurns();
    turns.remember(PERSONA);
    turns.clear();
    expect(turns.matches(PERSONA)).toBe(false);
  });

  it("keeps the manifest from ending the call", () => {
    // The actual regression: the model briefing lists "end-call (End the live
    // conversation)", the backend echoed it, and the router hung up.
    const turns = new HiddenTurns();
    const manifest =
      "You are running inside LILO, which executes these commands locally: " +
      "end-call (End the live conversation); media.play (Play a song, or " +
      "something by an artist).";
    turns.remember(manifest);
    expect(turns.matches(manifest)).toBe(true);
  });

  it("does not swallow a command the user actually said", () => {
    const turns = new HiddenTurns();
    turns.remember(PERSONA);
    expect(turns.matches("end the call")).toBe(false);
    expect(turns.matches("close lilo")).toBe(false);
  });
});