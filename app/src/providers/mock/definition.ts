import type { ProviderDefinition } from "../contract";
import { MockMark } from "./mark";
import { MockVoiceProvider } from "./mockProvider";

/** Names only: the mock pretends to speak with one of these. */
const MOCK_VOICES = ["cove", "ember", "breeze", "orbit"];

/** No network, no account: exercises the whole UI and the tool loop. */
export const mockProvider: ProviderDefinition = {
  id: "mock",
  icon: MockMark,
  shortLabel: "Mock",
  label: "Mock (offline demo)",
  description: "No network, no account. Validates the whole UI and the tool-calling loop.",
  selectable: true,
  requiresAccount: false,
  capabilities: { voice: false, voiceMode: false, login: false, phoneLogin: false, usage: true },
  protocol: {
    inbound: { userText: true, assistantText: true, nativeToolCalls: true, images: false },
    outbound: { text: true, stopSpeaking: true, systemPrompt: true, toolResult: true, image: false },
  },
  settings: [
    {
      key: "voice",
      kind: "select",
      labelKey: "provider.voice",
      options: MOCK_VOICES.map((voice) => ({ value: voice, label: voice })),
    },
  ],
  optionDefaults: { voice: "cove" },
  create: (deps) => new MockVoiceProvider({ runTool: deps.runTool }),
};
