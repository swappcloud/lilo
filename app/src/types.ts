export type Speaker = "user" | "assistant" | "system";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface TranscriptTurn {
  id: string;
  speaker: Speaker;
  text: string;
  final: boolean;
  timestamp: number;
}

export interface AccountView {
  email: string;
  name: string;
  /** Which backend this account belongs to (a `ProviderId`). */
  provider: string;
  /** Claude only: the organization UUID that scopes claude.ai requests. */
  org: string;
  deviceId: string;
  status: string;
  proxy: string;
  hasToken: boolean;
  /** Unix seconds when the access token expires (JWT `exp`), or null. */
  expiresAt: number | null;
  /** The subscription (`free`, `plus`, `pro`, `max`, …), when the provider says. */
  plan: string | null;
}

export interface AppSettings {
  useExternalGateway: boolean;
  externalGatewayUrl: string;
  gatewayAuthKey: string;
  /** Where the plugin marketplace lives; a folder path also works, for dev. */
  marketplaceUrl: string;
  providerId: string;
  defaultVoice: string;
  voiceMode: string;
  clientVersion: string;
  clientBuildNumber: string;
  userAgent: string;
  media: MediaSettings;
}

export interface MediaSettings {
  /** Playback engine. Only "mpv" today; Spotify and friends slot in here. */
  backend: string;
  /** "auto" | "yt-dlp" | "http" — "http" needs no Python, for small boards. */
  resolver: string;
  /** Explicit binary paths: a packaged app inherits a minimal PATH. */
  mpvPath: string;
  ytDlpPath: string;
  /** Piped-compatible instance used by the HTTP resolver. */
  httpResolverUrl: string;
  /** 0-100. */
  volume: number;
  /** Percentage of the current volume kept while the assistant speaks. */
  duckPercent: number;
  /** "high" (default) or "low" — only cap the bitrate when it is needed. */
  audioQuality: string;
  /** After a requested song, keep playing related ones (YouTube's autoplay). */
  autoplayRelated: boolean;
}

export interface SessionOutcome {
  answerSdp: string;
  voiceSessionId: string;
  voice: string;
  voiceMode: string;
  deviceId: string;
  accountEmail: string;
  proxySource: string;
}

export interface UploadOutcome {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  voiceSessionId: string;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TimeResult {
  iso: string;
  formatted: string;
  timezone: string;
  offsetMinutes: number;
  unix: number;
  weekday: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface EnvInfo {
  platform: string;
  webview: string;
  appVersion: string;
  nativeAudioAvailable: boolean;
}

// --- command protocol ------------------------------------------------------

export type CommandScope = "app" | "session" | "tool" | "prompt";

/**
 * Something the host must do. Effects are data, never UI calls: the same
 * outcome drives this app and the headless headless Linux device daemon.
 */
export type CommandEffect =
  | { kind: "interrupt" }
  | { kind: "endCall" }
  | { kind: "setMuted"; muted: boolean }
  | { kind: "sendHidden"; text: string }
  | { kind: "systemTurn"; text: string }
  | { kind: "toast"; text: string }
  | { kind: "earcon"; cue: "ack" | "error" }
  /** The command is parked until the user answers with `confirm_command`. */
  | { kind: "confirm"; command: string }
  | { kind: "clearConfirm" };

export interface CommandOutcome {
  command: string;
  scope: CommandScope;
  tool: string | null;
  args: Record<string, unknown>;
  consume: boolean;
  effects: CommandEffect[];
}

export interface CommandResultEvent {
  command: string;
  ok: boolean;
  /** One line for the transcript. */
  summary: string;
  /** Hidden turn for the model, so it narrates instead of refusing. */
  hiddenNote: string;
  /** The plugin returned selected data that needs a provider response. */
  followUp: boolean;
}

export interface CommandManifestEntry {
  name: string;
  scope: CommandScope;
  tool: string | null;
  description: string;
  requiresConfirm: boolean;
  examples: string[];
}

export interface ToolStatus {
  name: string;
  found: boolean;
  path: string | null;
  /** "managed" (LILO downloaded it), "system" (already present), "missing". */
  source: "managed" | "system" | "missing";
  /** Whether this platform has a verified automatic download. */
  canInstall: boolean;
  installHint: string;
  version: string | null;
}

export interface NowPlaying {
  artworkUrl?: string | null;
  title: string;
  artist: string;
  url: string;
  queueLength: number;
  paused: boolean;
  volume: number;
}

export interface MediaReport {
  resolver: string;
  playerFound: boolean;
  binaries: ToolStatus[];
  /** Something is missing that this platform can fetch on its own. */
  canInstall: boolean;
  nowPlaying: NowPlaying;
}

/** Removable disk areas, matching the Rust `StorageArea` values. */
export type StorageArea = "media" | "logs" | "cache";

export interface AreaUsage {
  area: StorageArea;
  bytes: number;
  clearable: boolean;
}

/** Disk LILO uses but does not offer to clear here. */
export type UsageKind = "plugins" | "webviews";

export interface UsageEntry {
  kind: UsageKind;
  bytes: number;
  files: number;
}

/** One installed plugin, as the Storage panel shows it. */
export interface PluginUsage {
  id: string;
  name: string;
  version: string;
  /** `quickjs` (embedded) or `process`. */
  runtime: string;
  enabled: boolean;
  loaded: boolean;
  bytes: number;
  files: number;
}

/** A part of LILO's process tree. */
export type ProcessKind = "host" | "plugins" | "webviews" | "media" | "other";

export interface ProcessGroup {
  kind: ProcessKind;
  rssBytes: number;
  cpuSeconds: number;
  threads: number;
  processes: number;
}

/** What the host and everything depending on it (plugins, webviews, player)
 *  is using — the app's footprint, not the system's. */
export interface ProcessUsage {
  rssBytes: number;
  cpuSeconds: number;
  threads: number;
  processes: number;
  uptimeSeconds: number;
  groups: ProcessGroup[];
}

export interface StorageReport {
  areas: AreaUsage[];
  usage: UsageEntry[];
  plugins: PluginUsage[];
  totalBytes: number;
}

/** How a plugin setting is rendered. Mirrors the Rust `FieldKind`. */
export type PluginFieldKind = "text" | "password" | "switch" | "select" | "range";

export interface PluginSettingField {
  key: string;
  kind: PluginFieldKind;
  label: string;
  help?: string | null;
  placeholder?: string | null;
  options?: { value: string; label: string }[];
  min?: number | null;
  max?: number | null;
  /** Used until the user sets a value. */
  default?: unknown;
}

export interface PluginStatusRow {
  label: string;
  value: string;
  state?: string | null;
}

export interface PluginUiAction {
  label: string;
  tool: string;
  args?: Record<string, unknown>;
  requiresConfirm?: boolean;
}

export interface PluginCardSource { title: string; tool: string }
export interface PluginProgressSource { title: string; tool: string; max: number }
export interface PluginFormField {
  key: string; label: string; kind: "text" | "number" | "select" | "switch";
  required?: boolean; options?: Array<{value:string;label:string}>;
  min?: number; max?: number; maxLength?: number;
}
export interface PluginFormSource { title:string; tool:string; submitLabel:string; fields:PluginFormField[] }

/** A tool the host polls for the background scene. */
export interface PluginSceneSource {
  tool: string;
  everySecs: number;
}

/** A live list: its rows come from `tool`, never from the description. */
export interface PluginListSource {
  title: string;
  tool: string;
  empty?: string | null;
}

/** One row a list tool returned. */
export interface PluginListItem {
  label: string;
  detail?: string | null;
  action?: PluginUiAction | null;
  edit?: { tool: string; label: string; matchParameter: string; valueParameter: string; value?: string; args?: Record<string, unknown> } | null;
  deleteAction?: PluginUiAction | null;
  /** A picture in the plugin's own `data/` folder, base64 text. */
  image?: PluginListImage | null;
}

export interface PluginListImage {
  file: string;
  mime: string;
}

export interface PluginUi {
  localized?: Record<string, Record<string, string>>;
  settings: PluginSettingField[];
  status: PluginStatusRow[];
  actions: PluginUiAction[];
  scene?: PluginSceneSource | null;
  list?: PluginListSource | null;
  lists?: PluginListSource[];
  cards?: PluginCardSource[];
  progress?: PluginProgressSource[];
  forms?: PluginFormSource[];
}

export type SceneKind =
  | "none"
  | "clear"
  | "sun"
  | "clouds"
  | "fog"
  | "rain"
  | "snow"
  | "storm"
  | "heat"
  | "cold";

export interface Scene {
  kind: SceneKind;
  /** 0..1. */
  intensity: number;
  night: boolean;
}

/** An expression LILO's face can show, asked for by a tool result. */
export type MoodKind = "happy" | "sad" | "angry" | "surprised";

export interface PluginManifest {
  /** Interface languages provided while this plugin is active. */
  languages?: Array<{ tag: string; name: string; messages: Record<string, string> }>;
  id: string;
  name: string;
  description?: string;
  localized?: Record<string, PluginPresentation>;
  version: string;
  api: number;
  capabilities: string[];
  /** Runtime hosts declared by the plugin manifest. */
  hosts?: Array<"desktop" | "daemon">;
}

export interface PluginPresentation {
  name: string;
  description: string;
}

export interface MarketplaceFile {
  path: string;
  sha256: string;
}

export interface MarketplaceEntry {
  id: string;
  name: string;
  version: string;
  api: number;
  description?: string;
  localized?: Record<string, PluginPresentation>;
  capabilities?: string[];
  /** Runtime hosts declared by the marketplace publisher. */
  hosts?: Array<"desktop" | "daemon">;
  path: string;
  entry: string;
  files: MarketplaceFile[];
}

/** A catalog entry plus what this machine already has installed. */
export interface CatalogEntry extends MarketplaceEntry {
  installed: boolean;
  installedVersion: string | null;
  updateAvailable: boolean;
}

/** A plugin as the settings page sees it. */
export interface PluginView {
  voiceProviders?: import("./providers/plugins/types").PluginVoiceProvider[];
  manifest: PluginManifest;
  tools: string[];
  /** Empty unless the plugin is loaded: a stopped plugin cannot be asked. */
  ui: PluginUi;
  /** Backed by a folder, so it can be deactivated, reactivated or removed. */
  manageable: boolean;
  /** The user has it on. Always true while it is loaded. */
  enabled: boolean;
  /** Registered and running right now. */
  loaded: boolean;
}

export interface ToolRun {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "error";
  result?: unknown;
  error?: string;
  timestamp: number;
}
