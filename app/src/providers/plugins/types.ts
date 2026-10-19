import type { ProtocolCapabilities } from "../contract";

export interface PluginVoiceProvider {
  id: string;
  label: string;
  description?: string;
  transport: { kind: "pcm"; inputSampleRate?: number; outputSampleRate?: number } | { kind: "webrtc"; channelLabel?: string; remoteChannel?: boolean } | { kind: "host"; adapter: string };
  settings?: { key: string; label: string; default: string; options: { value: string; label: string }[] }[];
  protocol?: ProtocolCapabilities | null;
  browser?: { loginUrl: string; homeUrl: string; allowedHosts: string[]; sessionProbe: string; phoneDriver?: string | null; phoneForm?: { entry?: string; entryText?: string; codeSwitch?: string; codeInputs?: string; phoneSwitch?: string; codeNeedsFocus?: boolean } | null } | null;
}
