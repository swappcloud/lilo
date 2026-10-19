/** The Rust commands only the ChatGPT adapter uses. */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { call, isTauri } from "../../lib/gateway";
import type { SessionOutcome } from "../../types";

export interface CreateSessionArgs {
  offerSdp: string;
  voice?: string;
  voiceMode?: string;
  languageCode?: string;
  voiceSessionId?: string;
  conversationId?: string;
  parentMessageId?: string;
}

export const createVoiceSession = (args: CreateSessionArgs) =>
  call<SessionOutcome>("create_voice_session", {
    offerSdp: args.offerSdp, voice: args.voice, voiceMode: args.voiceMode, languageCode: args.languageCode,
    resume: { voiceSessionId: args.voiceSessionId, conversationId: args.conversationId, parentMessageId: args.parentMessageId },
  });

export const releaseVoiceSession = (voiceSessionId: string) =>
  call<boolean>("release_voice_session", { voiceSessionId });

export const conversationHistory = (conversationId: string) =>
  call<unknown>("chatgpt_conversation_history", { conversationId });

/** A picture the conversation produced, downloaded by the host with the account's session. */
export const generatedImage = (fileId: string, conversationId?: string) =>
  call<{ mime: string; data: string }>("chatgpt_generated_image", { fileId, conversationId });

/**
 * The no-microphone seam (satellite): with `LILO_SATELLITE_IN`/
 * `LILO_SATELLITE_OUT` set, a phrase file is fed into the live session and the
 * assistant's audio is written to a file — no microphone, no UI, exactly the
 * shape the the headless Linux device's transport will use.
 */
export interface SatelliteInfo {
  input: boolean;
  output: boolean;
  /** Rust feeds a phrase file; a connected client feeds its own audio instead. */
  feed: boolean;
}

export const satelliteConfig = () => call<SatelliteInfo | null>("satellite_config");
export const satelliteStartInput = () => call<void>("satellite_start_input");
/** One 40 ms chunk of the assistant's audio, 16 kHz PCM16, base64. */
export const satelliteAudioOut = (chunk: string) =>
  call<void>("satellite_audio_out", { chunk });
export const satelliteFinishOutput = () => call<void>("satellite_finish_output");
/** The session is connected and listening: the client may speak now. */
export const satelliteReady = () => call<void>("satellite_ready");

export async function onSatelliteAudio(cb: (base64: string) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<string>("satellite-audio", (event) => cb(event.payload));
}

export async function onSatelliteInputDone(cb: () => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<unknown>("satellite-input-done", () => cb());
}

/**
 * The physical button: the appliance (or its test client) sends this, and the
 * app starts a session exactly as the wake word would.
 */
export async function onSatelliteActivate(cb: () => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<unknown>("satellite-activate", () => cb());
}

/** Upload only through this ChatGPT session's account. */
export const uploadVoiceImage = (voiceSessionId: string, dataBase64: string, mime: string, name: string) =>
  call<{ fileId: string }>("upload_voice_image", { voiceSessionId, dataBase64, mime, name });
