import type { HostPort } from "../../lib/hostPort";
import type { AppSettings, AccountView, PluginView } from "../../types";
import { DaemonBrowser } from "./daemonBrowser";

export interface DaemonState {
  version: string;
  plugins: PluginView[];
  accounts: AccountView[];
  phoneLoginAvailable: boolean;
  voiceAvailable: boolean;
  loginProviders?: string[];
  device?: { language: string; wakePhrase: string; wakeWord?: boolean; locales: string[] };
  wake?: { state: "off" | "starting" | "listening" | "blocked" };
}

export interface DaemonNetworkStatus {
  available: boolean;
  hasRadio: boolean;
  online: boolean;
  currentSsid: string | null;
  localIp: string | null;
  canScan: boolean;
  canJoin: boolean;
}

export interface DaemonScannedNetwork {
  ssid: string;
  signal: number;
  security: string | null;
  secured: boolean;
}

export interface DaemonNetworkScan {
  networks: DaemonScannedNetwork[];
}

export type DaemonVoiceState = "idle" | "starting" | "connected" | "error";

export interface DaemonVoiceEvent {
  sequence: number;
  speaker: "user" | "assistant";
  text: string;
  final: boolean;
  turnId?: string;
}

/** Safe phone projection. Provider credentials remain inside the daemon. */
export interface DaemonVoiceStatus {
  state: DaemonVoiceState;
  muted: boolean;
  sessionId?: string;
  providerId?: string;
  accountEmail?: string;
  error?: string;
  events: DaemonVoiceEvent[];
}

/** Network adapter. The domain API does not pretend to be Tauri IPC. */
export class DaemonHost implements HostPort {
  readonly features = { animations: false, voicePreferences: true };
  readonly browser: DaemonBrowser | null;
  constructor(private readonly token: string, key?: string) {
    this.browser = key && typeof globalThis.crypto?.getRandomValues === "function" ? new DaemonBrowser(key, body => this.request(body)) : null;
  }
  async savePreferences(preferences: { language: string; wakePhrase: string; wakeWord: boolean }): Promise<void> {
    await this.request({ operation: "setDevicePreferences", preferences: { ...preferences, locales: [] } });
  }

  async request<T>(operation: Record<string, unknown>): Promise<T> {
    const response = await fetch("/api", {
      method: "POST", credentials: "omit", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Lilo-Token": this.token },
      body: JSON.stringify(operation), signal: AbortSignal.timeout(operation.operation === "voiceStart" ? 90000 : 60000),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const message = result && typeof result === "object" && "error" in result && typeof result.error === "string"
        ? result.error : "Daemon request failed.";
      throw new Error(message);
    }
    return result as T;
  }

  async call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    switch (command) {
      case "list_plugins": return (await this.request<DaemonState>({ operation: "state" })).plugins as T;
      case "list_accounts": return (await this.request<DaemonState>({ operation: "state" })).accounts as T;
      case "get_settings": return this.request<T>({ operation: "settings" });
      case "wake_status": return (await this.request<DaemonState>({ operation: "state" })).wake as T;
      case "set_settings": {
        const settings = args.settings as AppSettings;
        return this.request<T>({ operation: "setPreferences", marketplaceUrl: settings.marketplaceUrl,
          media: settings.media, defaultVoice: settings.defaultVoice, voiceMode: settings.voiceMode, providerId: settings.providerId });
      }
      case "media_report": return this.request<T>({ operation: "invoke", id: "core.media", tool: "media_status", args: {} });
      case "network_status": return this.request<T>({ operation: "networkStatus" });
      case "network_scan": return this.request<T>({ operation: "networkScan" });
      case "network_join": return this.request<T>({ operation: "networkJoin", ssid: args.ssid, password: args.password });
      case "marketplace_list": return this.request<T>({ operation: "catalog" });
      case "plugin_install": return this.request<T>({ operation: "install", id: args.id });
      case "plugin_uninstall": return this.request<T>({ operation: "remove", id: args.id });
      case "set_plugin_enabled": return this.request<T>({ operation: "enable", id: args.id, enabled: args.enabled });
      case "plugin_settings": return (await this.request<{settings:unknown}>({ operation: "plugin", id: args.id })).settings as T;
      case "set_plugin_settings": return this.request<T>({ operation: "configure", id: args.id, settings: args.settings });
      case "remove_account": return this.request<T>({ operation: "removeAccount", provider: args.provider, email: args.email });
      case "run_tool": {
        const state = await this.request<DaemonState>({ operation: "state" });
        const owner = state.plugins.find(plugin => plugin.tools.includes(String(args.name)));
        if (!owner) throw new Error("No active plugin owns this tool.");
        return this.request<T>({ operation: "invoke", id: owner.manifest.id, tool: args.name, args: args.args ?? {} });
      }
      default: throw new Error(`This daemon does not support ${command}.`);
    }
  }
}
