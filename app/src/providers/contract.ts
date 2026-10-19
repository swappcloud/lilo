/**
 * The provider contract: what core knows about a voice backend.
 *
 * Core (stores, settings UI, command router) talks only to this module. A
 * backend is an adapter that declares a `ProviderDefinition` and registers it
 * from the composition root (`registry.ts`); nothing here imports an adapter,
 * so adding or removing one never edits shared code.
 */
import type { ComponentType } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import type { TranslationKey } from "../i18n";
import {
  onProviderLoginStatus,
  providerLoginCancel,
  providerLoginStart,
  providerProfileRefresh,
  type LoginStatus,
} from "../lib/gateway";
import type { AppSettings } from "../types";
import type { ToolRunner, VoiceProvider } from "./types";

/** A registered backend id. Validated at runtime with `isProviderId`. */
export type ProviderId = string;

/**
 * What a backend can do. The Settings UI renders per capability instead of
 * branching on the provider id, so a new backend only declares these flags.
 */
export interface ProviderCapabilities {
  /** Has a voice selector (voice names curated by the vendor). */
  voice: boolean;
  /** Has a voice-mode selector (standard / advanced / …). */
  voiceMode: boolean;
  /** Has an account sign-in flow. */
  login: boolean;
  /** Reuses the LAN phone-login flow. */
  phoneLogin: boolean;
  usage: boolean;
}

/**
 * What the *command protocol* can rely on, as opposed to what the settings UI
 * renders. A backend can have a voice picker and still have no way to accept a
 * system prompt, and the router must branch on the latter, never on an id.
 */
export interface ProtocolCapabilities {
  inbound: {
    /** Delivers the user's words as text (the command path depends on it). */
    userText: boolean;
    assistantText: boolean;
    /** Native tool/function calls, which would enable assistant-driven commands. */
    nativeToolCalls: boolean;
    /** Makes pictures in the conversation when asked (image generation). */
    images: boolean;
  };
  outbound: {
    /** A live text channel: hidden turns can be sent mid-session. */
    text: boolean;
    stopSpeaking: boolean;
    /** Accepts LILO's system prompt (live, or up front via `instructions`). */
    systemPrompt: boolean;
    toolResult: boolean;
    /** Accepts an uploaded image in the live session (vision). */
    image: boolean;
  };
}

/**
 * One setting a provider needs, declared as data so the settings page renders
 * it without knowing the provider. Same idea as a plugin's declarative UI.
 */
export interface ProviderSettingField {
  key: string;
  kind: "select" | "text" | "switch";
  labelKey?: TranslationKey;
  /** A plugin-owned label when no application translation key exists. */
  label?: string;
  helpKey?: TranslationKey;
  options?: ProviderSettingOption[];
  /**
   * Options that depend on the conversation language (a BCP-47 tag), e.g.
   * voices that only speak one language. Wins over `options` when present.
   */
  optionsFor?: (language: string) => ProviderSettingOption[];
  placeholder?: string;
}

/** One choice of a select; `labelKey`, when set, is translated over `label`. */
export interface ProviderSettingOption {
  value: string;
  label: string;
  labelKey?: TranslationKey;
}

/**
 * That a backend signs in through an embedded webview, and the two choices
 * that differ between them. The flow itself is generic: Rust drives every
 * backend's window through the same commands, keyed by the provider id.
 */
export interface ProviderLoginDeclaration {
  /** Renders the "paste a session" fallback for this backend. */
  manualPaste?: boolean;
  /** Select this backend once sign-in succeeds. */
  selectOnSuccess?: boolean;
}

/** The sign-in a caller can drive, built from the declaration above. */
export interface ProviderLoginFlow extends ProviderLoginDeclaration {
  login(): Promise<void>;
  cancel(): Promise<void>;
  /** Re-reads the identity without wiping the session. */
  refresh(): Promise<void>;
  /** Only this backend's status updates. */
  onStatus(cb: (status: LoginStatus) => void): Promise<UnlistenFn>;
}

/** A provider option whose source of truth is the Rust `settings.json`. */
export interface RustOptionMirror {
  setting: keyof AppSettings;
  normalize?: (value: string) => string;
}

export interface ProviderDeps {
  runTool?: ToolRunner;
}

/** What a backend's mark must accept, so the UI can size it anywhere. */
export interface ProviderMarkProps {
  size?: number;
  className?: string;
}

/** A backend's declaration. */
export interface ProviderDefinition {
  id: ProviderId;
  /** The backend's mark; the UI renders `meta.icon`, never an id switch. */
  icon: ComponentType<ProviderMarkProps>;
  /** Short name for buttons and cards ("ChatGPT", "Claude"). */
  shortLabel: string;
  label: string;
  description: string;
  /** Experimental transport requiring live account validation. */
  releaseStage?: "tested" | "beta";
  /** Hidden from the picker until its transport is implemented. */
  selectable: boolean;
  requiresAccount: boolean;
  /** Account owner for a plugin that reuses a native transport. */
  accountProviderId?: string;
  capabilities: ProviderCapabilities;
  protocol: ProtocolCapabilities;
  /** Rendered by the settings page, stored per provider. */
  settings: ProviderSettingField[];
  /** What a fresh option set starts with; keys must match `settings`. */
  optionDefaults: Record<string, string>;
  /** Repairs stored options (unknown values, older formats). */
  normalizeOptions?: (options: Record<string, string>) => Record<string, string>;
  /** Options mirrored from the Rust settings, keyed by option name. */
  rustOptionMirrors?: Record<string, RustOptionMirror>;
  create(deps: ProviderDeps): VoiceProvider;
  login?: ProviderLoginDeclaration;
}

export type ProviderMeta = Omit<
  ProviderDefinition,
  "create" | "login" | "optionDefaults" | "normalizeOptions" | "rustOptionMirrors"
>;

// --- runtime registry --------------------------------------------------------

const definitions = new Map<ProviderId, ProviderDefinition>();

/** Adds a backend. Called from the composition root only. */
export function registerProvider(definition: ProviderDefinition): void {
  if (definitions.has(definition.id)) {
    throw new Error(`provider "${definition.id}" is already registered`);
  }
  definitions.set(definition.id, definition);
}

/** Dynamic extensions may only replace entries in their own namespace. */
export function installPluginProvider(def: ProviderDefinition): void {
  if (!/^plugin:[a-zA-Z0-9_.-]{1,128}\/[a-zA-Z0-9_-]{1,64}$/.test(def.id)) throw new Error("Invalid plugin provider identity.");
  definitions.set(def.id, def);
}
export function removePluginProvider(id: string): void {
  if (id.startsWith("plugin:")) definitions.delete(id);
}
export function providerDefinition(id: string): ProviderDefinition | undefined { return definitions.get(id); }

export function providerIds(): ProviderId[] {
  return [...definitions.keys()];
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (definitions.has(value) || /^plugin:[a-zA-Z0-9_.-]{1,128}\/[a-zA-Z0-9_-]{1,64}$/.test(value));
}

function definition(id: ProviderId): ProviderDefinition {
  const found = definitions.get(id);
  if (!found && /^plugin:[a-zA-Z0-9_.-]{1,128}\/[a-zA-Z0-9_-]{1,64}$/.test(id)) return {
    id, icon: () => null, shortLabel: "Plugin provider", label: "Plugin provider", description: "Enable this provider plugin to connect.",
    selectable: false, requiresAccount: false, capabilities: {voice:false,voiceMode:false,login:false,phoneLogin:false,usage:false},
    protocol: {inbound:{userText:false,assistantText:false,nativeToolCalls:false,images:false},outbound:{text:false,stopSpeaking:false,systemPrompt:false,toolResult:false,image:false}},
    settings: [], optionDefaults: {}, create: () => { throw new Error("This provider plugin is unavailable."); },
  };
  if (!found) throw new Error(`unknown provider "${id}"`);
  return found;
}

export function providerMeta(id: ProviderId): ProviderMeta {
  const {
    create: _create,
    login: _login,
    optionDefaults: _defaults,
    normalizeOptions: _normalize,
    rustOptionMirrors: _mirrors,
    ...meta
  } = definition(id);
  return meta;
}

export function providerMetas(): ProviderMeta[] {
  return providerIds().map(providerMeta);
}

/** The backend to fall back to: the first one that needs no account. */
export function defaultProviderId(): ProviderId | undefined {
  const ids = providerIds();
  return ids.find((id) => !definition(id).requiresAccount) ?? ids[0];
}

export function createProvider(id: ProviderId, deps: ProviderDeps = {}): VoiceProvider {
  return definition(id).create(deps);
}

export function providerLogin(id: ProviderId): ProviderLoginFlow | undefined {
  const declared = definitions.get(id)?.login;
  if (!declared) return undefined;
  return {
    ...declared,
    login: () => providerLoginStart(id),
    cancel: () => providerLoginCancel(id),
    refresh: () => providerProfileRefresh(id),
    onStatus: (cb) =>
      onProviderLoginStatus((status) => {
        if (status.provider === id) cb(status);
      }),
  };
}

/** Ids that can sign in through an embedded webview. */
export function loginProviderIds(): ProviderId[] {
  return providerIds().filter((id) => definitions.get(id)?.login !== undefined);
}

/** A fresh, mutable option map for every registered backend. */
export function providerOptionDefaults(): Record<ProviderId, Record<string, string>> {
  const defaults: Record<ProviderId, Record<string, string>> = {};
  for (const [id, def] of definitions) defaults[id] = { ...def.optionDefaults };
  return defaults;
}

/** Stored options merged over the defaults, each repaired by its owner. */
export function normalizeProviderOptions(
  stored: Record<string, Record<string, string>>,
): Record<ProviderId, Record<string, string>> {
  const merged = providerOptionDefaults();
  for (const [id, options] of Object.entries(stored)) {
    if (/^plugin:[a-zA-Z0-9_.-]{1,128}\/[a-zA-Z0-9_-]{1,64}$/.test(id)) merged[id] = {...options};
  }
  for (const [id, def] of definitions) {
    const options = { ...merged[id], ...(stored[id] ?? {}) };
    merged[id] = def.normalizeOptions ? def.normalizeOptions(options) : options;
  }
  return merged;
}

/** The Rust setting an option is mirrored into, if its owner declared one. */
export function rustOptionMirror(id: ProviderId, key: string): RustOptionMirror | undefined {
  return definitions.get(id)?.rustOptionMirrors?.[key];
}

/** Fold the Rust-owned settings back into the options of their owners. */
export function applyRustOptionMirrors(
  options: Record<ProviderId, Record<string, string>>,
  settings: AppSettings,
): Record<ProviderId, Record<string, string>> {
  const next = { ...options };
  for (const [id, def] of definitions) {
    if (!def.rustOptionMirrors) continue;
    const entry = { ...next[id] };
    let touched = false;
    for (const [key, mirror] of Object.entries(def.rustOptionMirrors)) {
      const raw = settings[mirror.setting];
      if (typeof raw !== "string" || raw === "") continue;
      entry[key] = mirror.normalize ? mirror.normalize(raw) : raw;
      touched = true;
    }
    if (touched) next[id] = entry;
  }
  return next;
}

/** Test seam: start from an empty registry. */
export function clearProvidersForTests(): void {
  definitions.clear();
}
