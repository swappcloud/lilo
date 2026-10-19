import { describe, expect, it } from "vitest";

import { translate } from "../i18n";
import { replyLanguageDirective, resolveLanguage } from "./language";
import type { TranscriptTurn } from "../types";
import {
  effectiveGreeting,
  effectivePersona,
  usePreferencesStore,
} from "./preferencesStore";
import { deriveTitle, makeTitle } from "./sessionStore";

function turn(speaker: "user" | "assistant" | "system", text: string): TranscriptTurn {
  return { id: text, speaker, text, final: true, timestamp: 0 };
}

describe("conversation titles", () => {
  it("ignores what the app injected as the user", () => {
    // The persona, the reply-language rule and the greeting are sent as the
    // user but are not the user's words: titling from them made every session
    // read the same sentence.
    const prefs = usePreferencesStore.getState();
    const turns = [
      turn("user", effectivePersona(prefs)),
      turn("user", replyLanguageDirective(prefs.language, resolveLanguage(prefs.language))),
      turn("user", effectiveGreeting(prefs)),
      turn("user", "Play Walk by Pantera"),
      turn("assistant", "Playing."),
    ];
    expect(deriveTitle(turns)).toBe("Play Walk by Pantera");
  });

  it("has no title until the user actually says something", () => {
    const prefs = usePreferencesStore.getState();
    expect(deriveTitle([turn("user", effectiveGreeting(prefs))])).toBeNull();
  });

  it("still strips filler and shortens long messages", () => {
    expect(makeTitle("can you play some music")).toBe("Play some music");
    expect(makeTitle("   ")).toBe(translate("conversations.newTitle"));
    expect(makeTitle("x".repeat(80)).endsWith("…")).toBe(true);
  });
});
