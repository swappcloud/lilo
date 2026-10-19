import { describe, expect, it, vi } from "vitest";

vi.mock("./sessionStore", () => ({
  isHiddenTurn: () => false,
  useSessionStore: { subscribe: () => () => {} },
}));

import { unreadText } from "./moodContext";
import type { TranscriptTurn } from "../types";

const turn = (text: string, final = false): TranscriptTurn => ({
  id: "t1",
  speaker: "assistant",
  text,
  final,
  timestamp: 0,
});

describe("unreadText", () => {
  it("waits for a word to complete while the caption streams", () => {
    expect(unreadText(turn("Obri"), 0)).toEqual(["", 0]);
    expect(unreadText(turn("Obrigado, ado"), 0)).toEqual(["Obrigado,", 9]);
  });

  it("reads the rest once the turn is final", () => {
    expect(unreadText(turn("Obrigado, adorei", true), 9)).toEqual(["Obrigado, adorei", 16]);
  });

  it("starts over when the caption was rewritten shorter", () => {
    expect(unreadText(turn("Oi", true), 30)).toEqual(["Oi", 2]);
  });
});
