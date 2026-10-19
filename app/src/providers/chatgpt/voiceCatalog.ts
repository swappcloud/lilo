/**
 * ChatGPT's vendor vocabulary — the voices and voice modes the upstream web
 * voice accepts. Provider-local on purpose: a second backend ships its own
 * catalog next to its provider, and the generic layers stay vocabulary-free.
 */

/** Voice names accepted by `chatgpt.com/realtime/wm`. */
export const CHATGPT_VOICES = [
  "cove",
  "ember",
  "breeze",
  "fathom",
  "glimmer",
  "juniper",
  "maple",
  "orbit",
  "vale",
] as const;

/** Upstream only accepts these values for `voice_mode`. */
export const CHATGPT_VOICE_MODES = ["wingman", "standard", "advanced"] as const;

export type ChatGptVoiceMode = (typeof CHATGPT_VOICE_MODES)[number];

export function normalizeChatGptVoiceMode(value: string): ChatGptVoiceMode {
  return (CHATGPT_VOICE_MODES as readonly string[]).includes(value)
    ? (value as ChatGptVoiceMode)
    : "wingman";
}
