import { describe, expect, it } from "vitest";

import type { Speaker, TranscriptTurn } from "../types";
import { continuityContext, hasUserSpeech, spokenTurns } from "./conversationPolicy";

let next = 0;
function turn(speaker: Speaker, text: string): TranscriptTurn {
  next += 1;
  return { id: `t${next}`, speaker, text, final: true, timestamp: next };
}

describe("conversation policy", () => {
  it("transfers early details and complete recent turns when changing providers", () => {
    const turns = [turn("user", "My project is called Atlas."), ...Array.from({ length: 30 }, (_, i) => turn(i % 2 ? "assistant" : "user", `Detail ${i}: ${"text ".repeat(60)}`))];
    const context = continuityContext(turns)!;
    expect(context).toContain("My project is called Atlas.");
    expect(context).toContain(turns.at(-1)!.text.trim());
    expect(continuityContext(turns, turns.at(-2)!.id)).not.toContain("My project");
    expect(continuityContext(turns, turns.at(-1)!.id)).toBeNull();
    expect(continuityContext(turns, "unknown-id")).toContain("My project");
    const bounded = continuityContext([turn("user", "A".repeat(70_000)), turn("assistant", "Latest answer")])!;
    expect(bounded.length).toBeLessThan(33_000);
    expect(bounded).toContain("omitted");
    expect(bounded).toContain("Latest answer");
  });
  it("counts only what was really said", () => {
    const spoken = spokenTurns(
      [
        turn("user", "You are LILO."),
        turn("user", "[LILO] result for weather.mood"),
        turn("system", "Conversation ended"),
        turn("assistant", "  "),
        turn("assistant", "Hi!"),
        turn("user", "Play some jazz"),
      ],
      (text) => text === "You are LILO.",
    );
    expect(spoken.map((t) => t.text)).toEqual(["Hi!", "Play some jazz"]);
  });

  it("keeps a greeting-only conversation out of the recap", () => {
    const spoken = spokenTurns([turn("assistant", "Hi! How can I help?")]);
    expect(hasUserSpeech(spoken)).toBe(false);
    expect(continuityContext(spoken)).toBeNull();
  });

  it("keeps source chronology and complete turns within its context budget", () => {
    const turns = Array.from({ length: 30 }, (_, i) => turn(i % 2 ? "assistant" : "user", `line ${i}`));
    const context = continuityContext(turns)!;
    expect(context).toContain("User: line 0");
    expect(context).toContain("Assistant: line 29");
    expect(context.indexOf("line 0")).toBeLessThan(context.indexOf("line 29"));
  });
});
