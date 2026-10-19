import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { call, isTauri } from "../../lib/gateway";

export interface GrokVoiceEvent {
  type: string;
  conversationId?: string;
  code?: number;
  reason?: string;
  /** Generated-image parts (`type: "image"`). */
  id?: string;
  part?: number;
  parts?: number;
  mime?: string;
  prompt?: string;
  data?: string;
  width?: number;
  height?: number;
  message?: unknown;
}
export interface GrokStartOptions {
  voice: string;
  language?: string;
  instructions?: string;
  conversationId?: string;
}
export const grokVoiceStart = (options: GrokStartOptions) => call<string>("grok_voice_start", { options });
export const grokVoiceStop = () => call<void>("grok_voice_stop");
export const grokVoiceSend = (event: Record<string, unknown>) => call<void>("grok_voice_send", { event });
export async function onGrokVoice(cb: (events: GrokVoiceEvent[]) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<GrokVoiceEvent[]>("grok-voice", (event) => cb(event.payload));
}
