import type { ProviderDefinition } from "../contract";
import { ChatGptMark } from "./mark";
import {
  CHATGPT_VOICES,
  CHATGPT_VOICE_MODES,
  normalizeChatGptVoiceMode,
} from "./voiceCatalog";
import { ChatGptWebVoiceProvider } from "./webVoiceProvider";

/**
 * The ChatGPT web voice path: captions in both directions, no tool calling
 * (`client_tools` is ignored upstream), and the "system prompt" is really a
 * hidden first user message. Assistant-driven commands stay off here — the
 * assistant's text is synthesized to audio server-side, so any marker protocol
 * would be read out loud.
 */
export const chatgptProvider: ProviderDefinition = {
  id: "chatgpt-web",
  icon: ChatGptMark,
  shortLabel: "ChatGPT",
  label: "ChatGPT Web Voice (web session)",
  description:
    "Drives chatgpt.com/realtime/wm with your own web access_token. Voice time follows your ChatGPT plan (free is ~2h/day); LILO shows what the server reports.",
  selectable: true,
  requiresAccount: true,
  capabilities: { voice: true, voiceMode: true, login: true, phoneLogin: true, usage: true },
  protocol: {
    inbound: { userText: true, assistantText: true, nativeToolCalls: false, images: true },
    outbound: { text: true, stopSpeaking: true, systemPrompt: true, toolResult: false, image: true },
  },
  settings: [
    {
      key: "voice",
      kind: "select",
      labelKey: "provider.voice",
      options: CHATGPT_VOICES.map((voice) => ({ value: voice, label: voice })),
    },
    {
      key: "voiceMode",
      kind: "select",
      labelKey: "provider.voiceMode",
      options: CHATGPT_VOICE_MODES.map((mode) => ({ value: mode, label: mode })),
    },
  ],
  optionDefaults: { voice: "cove", voiceMode: "wingman" },
  normalizeOptions: (options) => ({
    ...options,
    voiceMode: normalizeChatGptVoiceMode(options.voiceMode ?? ""),
  }),
  rustOptionMirrors: {
    voice: { setting: "defaultVoice" },
    voiceMode: { setting: "voiceMode", normalize: normalizeChatGptVoiceMode },
  },
  create: () => new ChatGptWebVoiceProvider(),
  login: { manualPaste: true, selectOnSuccess: true },
};
