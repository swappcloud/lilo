/** The Rust commands only the Claude adapter uses. */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { call, isTauri } from "../../lib/gateway";

/** One engine report; `type` decides the rest of its shape. */
export interface ClaudeVoiceEvent {
  type: string;
  [key: string]: unknown;
}

/** Resolves with the conversation id once the engine is live — a refused socket throws. */
export const claudeVoiceStart = (options: {
  voice?: string;
  model?: string;
  /** claude.ai's voice language code — see `claudeLanguage`. */
  language?: string;
  /** The same language as a BCP-47 tag, for the instructions turn. */
  locale?: string;
  /** `tts_speed` multiplier ("0.8", "1", "1.2"). */
  speed?: string;
  /** Persona, command manifest and language rule, sent as the first turn. */
  instructions?: string;
  /** Resume this claude.ai conversation instead of creating a new one. */
  conversationId?: string;
}) => call<string>("claude_voice_start", { options });
export const claudeVoiceStop = () => call<void>("claude_voice_stop");
/** One 16 kHz PCM16 microphone chunk, base64, for the voice socket. */
export const claudeVoiceAudio = (chunk: string) => call<void>("claude_voice_audio", { chunk });

export async function onClaudeVoice(
  cb: (events: ClaudeVoiceEvent[]) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<ClaudeVoiceEvent[]>("claude-voice", (event) => cb(event.payload));
}
