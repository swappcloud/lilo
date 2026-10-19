import type { ProviderDefinition, ProviderMarkProps } from "../contract";
import { GrokWebVoiceProvider } from "./webVoiceProvider";

function GrokMark({ size = 14, className }: ProviderMarkProps) {
  return <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="8" /><path d="M7 17 20 4M12 12h8" />
  </svg>;
}

export const grokProvider: ProviderDefinition = {
  id: "grok-web", icon: GrokMark, shortLabel: "Grok", label: "Grok Voice (web session)",
  releaseStage: "beta",
  description: "Uses Grok's live voice with your own web account. Availability and voice limits follow your Grok account.",
  selectable: true, requiresAccount: true,
  capabilities: { voice: true, voiceMode: false, login: true, phoneLogin: true, usage: false },
  protocol: {
    inbound: { userText: true, assistantText: true, nativeToolCalls: false, images: true },
    outbound: { text: true, stopSpeaking: true, systemPrompt: true, toolResult: false, image: false },
  },
  settings: [{ key: "voice", kind: "select", labelKey: "provider.voice",
    options: ["Ara", "Eve", "Leo", "Rex", "Sal"].map((label) => ({ value: label.toLowerCase(), label })) }],
  optionDefaults: { voice: "ara" },
  normalizeOptions: (options) => ({ ...options, voice: ["ara", "eve", "leo", "rex", "sal"].includes(options.voice) ? options.voice : "ara" }),
  create: () => new GrokWebVoiceProvider(),
  login: { selectOnSuccess: true },
};
