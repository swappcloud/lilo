import { invoke } from "@tauri-apps/api/core";
import { hostPort } from "./hostPort";
export { version as APP_VERSION } from "../../../package.json";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { SharedImage } from "../providers/types";

import type {
  AccountView,
  AppSettings,
  CommandManifestEntry,
  CommandOutcome,
  CommandResultEvent,
  EnvInfo,
  CatalogEntry,
  MediaReport,
  PluginView,
  ProcessUsage,
  StorageArea,
  StorageReport,
  ToolDescriptor,
} from "../types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function hasHost(): boolean { return hostPort() !== null || isTauri(); }

/** Invokes a Rust command; adapters use it for their own commands. */
export async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const port = hostPort();
  if (port) return port.call<T>(command, args);
  if (!isTauri()) {
    throw new Error(
      `Tauri IPC is unavailable in a plain browser. Run \`npm run dev\` to use the "${command}" command.`,
    );
  }
  return invoke<T>(command, args);
}

// --- settings -------------------------------------------------------------

export const getSettings = () => call<AppSettings>("get_settings");
export const exportLogs = (title: string) => call<boolean>("export_logs", { title });
export const setSettings = (settings: AppSettings) =>
  call<void>("set_settings", { settings });

// --- accounts -------------------------------------------------------------

export const listAccounts = () => call<AccountView[]>("list_accounts");
export const addAccount = (
  email: string,
  accessToken: string,
  deviceId?: string,
  proxy?: string,
) => call<void>("add_account", { email, accessToken, deviceId, proxy });
export const removeAccount = (provider: string, email: string) =>
  call<boolean>("remove_account", { provider, email });

export interface LoginStatus {
  /** Which backend this is about. */
  provider: string;
  status: "ok" | "error" | string;
  email?: string;
  message?: string;
}

/** Opens a backend's embedded sign-in window. */
export const providerLoginStart = (provider: string) =>
  call<void>("provider_login", { provider });
export const providerLoginCancel = (provider: string) =>
  call<void>("provider_login_cancel", { provider });
/** Re-reads the signed-in identity without wiping the session. */
export const providerProfileRefresh = (provider: string) =>
  call<void>("provider_profile_refresh", { provider });
/** Every backend's sign-in reports here; `status.provider` says whose. */
export async function onProviderLoginStatus(
  cb: (status: LoginStatus) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<LoginStatus>("provider-login-status", (event) => cb(event.payload));
}

// --- phone login over LAN --------------------------------------------------

export interface PhoneLoginInfo {
  url: string;
  port: number;
  key: string;
  qrSvg: string;
  addresses: Array<{ label: string; url: string; qrSvg: string }>;
  windowsFirewall: boolean;
}

/**
 * Starts the LAN helper server for `provider`; returns the pairing URL + QR
 * code. `accent` (`#rrggbb` pair) colours the phone page like the app.
 */
export const startPhoneLogin = (provider: string, accent?: [string, string]) =>
  call<PhoneLoginInfo>("start_phone_login", { provider, accent });
export const stopPhoneLogin = () => call<void>("stop_phone_login");
/** Stops the helper server AND closes the login window (cancel path). */
export const cancelPhoneLogin = () => call<void>("cancel_phone_login");

// --- tools ----------------------------------------------------------------

// --- command protocol -----------------------------------------------------
//
// Matching lives in Rust (`lilo-core`) so the headless headless Linux device daemon runs
// exactly the same rules. The frontend only forwards captions and applies the
// effects it gets back.

/**
 * Feed one caption to the router. Slotless commands ("pause") come back
 * immediately; commands carrying free text ("play <song>") are released
 * through `onCommand` once the caption stops growing, because acting on a
 * partial would play the wrong song.
 */
export const handleUtterance = (
  text: string,
  speaker: "user" | "assistant" | "system",
  turnId: string,
  isFinal: boolean,
) =>
  call<CommandOutcome[]>("handle_utterance", {
    text,
    speaker,
    turnId,
    isFinal,
  });

export interface LocalVoiceTranscript {
  version: 1;
  turnId: string;
  text: string;
  isFinal: boolean;
}
export const handleLocalUtterance = (transcript: LocalVoiceTranscript) =>
  call<CommandOutcome[]>("handle_local_utterance", { transcript });

export const listCommands = (locale?: string) => call<CommandManifestEntry[]>("list_commands", { locale });
/** Appended to the hidden persona so the model knows LILO already acted. */
export const commandPromptLine = (hasFollowUp: boolean) =>
  call<string>("command_prompt_line", { hasFollowUp });
/** Shared persona and language prompt, with facts supplied for this surface. */
export interface OpeningPrompt {
  persona: string;
  manifest: string;
  directive: string;
  recap: string;
  full: string;
}
export const buildOpeningPrompt = (input: {
  customPersona: string | null;
  languagePreference: string;
  resolvedLanguage: string;
  preferredLanguageName: string;
  resolvedLanguageName: string;
  commandContext: string;
  surfaceFacts: string;
  recap: string;
}) => call<OpeningPrompt>("build_opening_prompt", input);
/** Rebuilds the registry after the wake phrase changes. */
export const setAssistantName = (name: string) =>
  call<void>("set_assistant_name", { name });
/** Restrict matching to these registry locales (e.g. ["pt"]). */
export const setCommandLocales = (locales: string[]) =>
  call<void>("set_command_locales", { locales });
/** Languages the built-in commands are written in. */
export const commandLocales = () => call<string[]>("command_locales");

/** Clears per-call cooldowns when a conversation starts or ends. */
export const resetCommands = () => call<void>("reset_commands");
export const mediaReport = () => call<MediaReport>("media_report");
/** Loudness of the playing track; `null` while stopped or paused. */
export const mediaLevels = () =>
  call<{ level: number; low: number; high: number } | null>("media_levels");

// --- storage ---------------------------------------------------------------

export const storageReport = () => call<StorageReport>("storage_report");
/** Clears one area; resolves with the number of bytes freed. */
export const storageClear = (area: StorageArea) =>
  call<number>("storage_clear", { area });

/** The host process tree: memory, CPU, threads. Sampled on a timer. */
export const processReport = () => call<ProcessUsage>("process_report");

export async function onCommand(
  cb: (outcomes: CommandOutcome[]) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<CommandOutcome[]>("lilo://command", (event) => cb(event.payload));
}

export interface PluginEvent {
  topic: string;
  payload: unknown;
  source: string;
}

/** Every event on the plugin bus. */
export async function onPluginEvent(cb: (event: PluginEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<PluginEvent>("lilo://plugin-event", (event) => cb(event.payload));
}

/** A picture a plugin keeps in its `data/` folder, as a `data:` URL. */
export const pluginImage = (plugin: string, file: string, mime: string) =>
  call<string>("plugin_image", { plugin, file, mime });

/** Save a stored picture in the operating system's Downloads folder. */
export const downloadPluginImage = (plugin: string, file: string, mime: string) =>
  call<string>("plugin_image_download", { plugin, file, mime });

/** Publish onto the plugin bus as the host. */
export const publishEvent = (topic: string, payload: unknown) =>
  call<void>("publish_event", { topic, payload });

export interface StatusAction {
  label: string;
  tool: string;
  args: unknown;
}

export interface StatusItem {
  source: string;
  label: string;
  endsAt: number | null;
  left: number | null;
  actions: StatusAction[];
}

export const statusbarCurrent = () => call<StatusItem | null>("statusbar_current");

export async function onStatusbar(cb: (item: StatusItem | null) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<StatusItem | null>("lilo://statusbar", (event) => cb(event.payload));
}

export async function onEndSession(cb: (tool: string) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<string>("lilo://end-session", (event) => cb(event.payload));
}

/** A screenshot was captured and uploaded; the live session may show it. */
export interface ScreenEvent extends SharedImage {
  text: string;
}

export async function onScreen(cb: (screen: ScreenEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<ScreenEvent>("lilo://screen", (event) => cb(event.payload));
}

/** A tool asked the voice backend for a picture (`imagine: { prompt }`). */
export async function onImagine(cb: (request: { prompt: string }) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<{ prompt: string }>("lilo://imagine", (event) => cb(event.payload));
}

/** A plugin tool returned a background scene. */
export async function onScene(cb: (scene: unknown) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<unknown>("lilo://scene", (event) => cb(event.payload));
}

/** A tool asked LILO's face to show (or drop) an expression. */
export async function onMood(cb: (mood: unknown) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<unknown>("lilo://mood", (event) => cb(event.payload));
}

export async function onCommandResult(
  cb: (result: CommandResultEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<CommandResultEvent>("lilo://command-result", (event) =>
    cb(event.payload),
  );
}

// --- tools ----------------------------------------------------------------

export const listTools = () => call<ToolDescriptor[]>("list_tools");

/** Answer a command the router parked for confirmation. */
export const confirmCommand = (command: string, approved: boolean) =>
  call<void>("confirm_command", { command, approved });

// --- plugins ---------------------------------------------------------------

/** Every plugin the host knows about — running or not — with each one's UI. */
export const listPlugins = () => call<PluginView[]>("list_plugins");
/** Deactivates it (files, data and settings kept) or brings it back. */
export const setPluginEnabled = (id: string, enabled: boolean) =>
  call<void>("set_plugin_enabled", { id, enabled });
export const pluginSettings = (id: string) =>
  call<Record<string, unknown>>("plugin_settings", { id });
/** Persist and push to the plugin, so a change applies without a restart. */
export const setPluginSettings = (id: string, settings: Record<string, unknown>) =>
  call<void>("set_plugin_settings", { id, settings });

// --- marketplace ------------------------------------------------------------

/** Catalog from the configured marketplace, annotated with local state. */
export const marketplaceList = () => call<CatalogEntry[]>("marketplace_list");
/** Install or update: the same operation (download, verify, replace). */
export const pluginInstall = (id: string) => call<void>("plugin_install", { id });
export const pluginUninstall = (id: string) => call<void>("plugin_uninstall", { id });
export const runTool = (name: string, args: Record<string, unknown>) =>
  call<unknown>("run_tool", { name, args });

// --- native audio + env ---------------------------------------------------

export const getEnvInfo = () => call<EnvInfo>("get_env_info");
export const nativeAudioAvailable = () =>
  call<boolean>("native_audio_available");
export const startNativeAudio = () => call<void>("start_native_audio");
export const stopNativeAudio = () => call<void>("stop_native_audio");

// --- wake word (native macOS sidecar) ------------------------------------

export const wakeWordSupported = () => call<boolean>("wake_word_supported");

export const setWakeWatch = (enabled: boolean, phrase: string) =>
  call<void>("set_wake_watch", { enabled, phrase });

/** True while the native listener process is actually alive. */
export const wakeWatchState = () => call<boolean>("wake_watch_state");

/**
 * Fires when the native listener cannot work until the user changes something
 * (payload), or when it recovers (null payload).
 */
export async function onWakeBlocked(
  cb: (block: { reason: string; detail?: string } | null) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<{ reason: string; detail?: string } | null>(
    "wake-blocked",
    (event) => cb(event.payload),
  );
}

export interface StartupState {
  step: string;
  done: boolean;
}

/** Current startup step, for a frontend that mounted after the events fired. */
export const startupState = () => call<StartupState>("startup_state");

export async function onStartup(
  cb: (state: StartupState) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<StartupState>("lilo://startup", (event) => cb(event.payload));
}

/** Open a URL in the OS — used for deep links into system settings. */
export const openExternal = (url: string) => call<void>("open_external", { url });

export async function onWakeWord(cb: () => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen("wake-word", () => cb());
}

/** Partial and final speech recognized by the native wake listener. */
export async function onLocalVoiceTranscript(
  cb: (transcript: unknown) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<unknown>("local-voice-transcript", (event) => cb(event.payload));
}
