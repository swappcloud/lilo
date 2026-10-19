import type { ProviderDefinition } from "../contract";
import { ClaudeMark } from "./mark";
import {
  CLAUDE_MODELS,
  CLAUDE_SPEEDS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_SPEED,
  DEFAULT_CLAUDE_VOICE,
  claudeVoicesFor,
  normalizeClaudeSpeed,
  normalizeClaudeVoice,
} from "./voiceCatalog";
import { ClaudeWebVoiceProvider } from "./webVoiceProvider";

/**
 * Claude voice mode. The voice socket has no client-text message, so there is
 * no live text channel; the system prompt still arrives, as the conversation's
 * first text turn before voice starts (`instructions`). Stopping is local:
 * the rest of the turn's audio is dropped.
 */
export const claudeProvider: ProviderDefinition = {
  id: "claude-web",
  icon: ClaudeMark,
  shortLabel: "Claude",
  label: "Claude Voice (web session)",
  description:
    "Drives claude.ai voice mode with your own web session. Upstream beta; voice minutes count against your Claude plan.",
  selectable: true,
  requiresAccount: true,
  capabilities: { voice: true, voiceMode: false, login: true, phoneLogin: true, usage: false },
  protocol: {
    inbound: { userText: true, assistantText: true, nativeToolCalls: false, images: false },
    outbound: { text: false, stopSpeaking: true, systemPrompt: true, toolResult: false, image: false },
  },
  settings: [
    {
      key: "model",
      kind: "select",
      labelKey: "provider.model",
      options: CLAUDE_MODELS.map((model) => ({ value: model.id, label: model.label })),
    },
    {
      key: "voice",
      kind: "select",
      labelKey: "provider.voice",
      // Each language has its own voices; claude.ai calls the picker "Style".
      optionsFor: (language) =>
        claudeVoicesFor(language).map((voice) => ({ value: voice.id, label: voice.label })),
    },
    {
      key: "speed",
      kind: "select",
      labelKey: "provider.speed",
      options: CLAUDE_SPEEDS.map((speed) => ({
        value: speed.value,
        label: speed.value,
        labelKey: speed.labelKey,
      })),
    },
  ],
  optionDefaults: {
    model: DEFAULT_CLAUDE_MODEL,
    voice: DEFAULT_CLAUDE_VOICE,
    speed: DEFAULT_CLAUDE_SPEED,
  },
  // The voice used to be free text; the picker only offers known ones.
  normalizeOptions: (options) => ({
    ...options,
    voice: normalizeClaudeVoice(options.voice),
    speed: normalizeClaudeSpeed(options.speed),
  }),
  create: () => new ClaudeWebVoiceProvider(),
  login: { selectOnSuccess: true },
};
