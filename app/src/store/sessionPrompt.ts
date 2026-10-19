/**
 * LILO's opening context: who the assistant is, which commands the app runs
 * itself, and which language to answer in.
 *
 * One prompt for every backend. How it is delivered differs — a backend with a
 * live text channel gets hidden turns once the session is up, one without gets
 * it before the conversation starts — but the words come from the shared Rust prompt builder.
 */
import { useShellStyle } from "../app/shellStyle";
import { buildOpeningPrompt, commandPromptLine, type OpeningPrompt } from "../lib/gateway";
import { usePreferencesStore, type Preferences } from "./preferencesStore";
import { languageName, resolveLanguage } from "./language";
import type { ProtocolCapabilities } from "../providers";

/** Builds the prompt for a backend, from its protocol capabilities. */
export async function openingPrompt(
  protocol: ProtocolCapabilities,
  recap: string | null = null,
): Promise<OpeningPrompt> {
  const prefs = usePreferencesStore.getState();
  const resolved = resolveLanguage(prefs.language);
  // Capability-gated, never id-gated: a backend that cannot take a system
  // prompt simply gets no manifest.
  const manifest = protocol.outbound.systemPrompt
    ? await commandPromptLine(protocol.outbound.text).catch(() => "")
    : "";
  return buildOpeningPrompt({
    customPersona: prefs.systemPrompt,
    languagePreference: prefs.language,
    resolvedLanguage: resolved,
    preferredLanguageName: languageName(prefs.language === "auto" ? resolved : prefs.language),
    resolvedLanguageName: languageName(resolved),
    commandContext: protocol.outbound.systemPrompt ? manifest : "",
    surfaceFacts: protocol.outbound.systemPrompt
      ? aboutLilo(prefs, useShellStyle.getState().style)
      : "",
    recap: recap ?? "",
  });
}

/**
 * What LILO is and how it is used, for "what are you?" and "how do I…?".
 * Facts only, pinned to English like the command list, and closed with a rule
 * against inventing the rest.
 */
export function aboutLilo(
  prefs: Pick<Preferences, "wakeWord" | "wakePhrase">,
  style: "companion" | "classic",
): string {
  const start = prefs.wakeWord
    ? `by saying "${prefs.wakePhrase}", by clicking LILO or by pressing Space`
    : "by clicking LILO or by pressing Space (the wake phrase is turned off in Settings)";
  const shell =
    style === "companion"
      ? "LILO lives on my desktop as a small character; the menu bar, the tray icon " +
        "and a right-click on LILO hold everything else, and dragging LILO moves it."
      : "LILO's window shows the conversation, with panels for the transcript, " +
        "past conversations, commands and settings.";
  return (
    "If I ask about you or the app: LILO means \"Listen In. Listen Out.\" — a free " +
    "voice interface for AI that runs on my computer and talks through my own " +
    `account with the AI service. I start a conversation ${start}; clicking LILO ` +
    `while you speak interrupts you. ${shell} Settings cover the voice and account, ` +
    "the wake phrase, appearance, music and plugins; plugins add new abilities and " +
    "are installed from the marketplace in Settings. Music plays through LILO " +
    "itself, and the weather can set a background mood. Answer such questions " +
    "from these facts; if something is not covered, say you are not sure rather " +
    "than guess."
  );
}
