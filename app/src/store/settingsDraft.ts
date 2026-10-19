import { useMemo } from "react";
import { create } from "zustand";

import { ownerCall } from "../app/windowRole";
import { setPluginSettings } from "../lib/gateway";
import type { ProviderId } from "../providers";
import type { AppSettings } from "../types";
import { usePluginsStore } from "./pluginsStore";
import { DEFAULTS, usePreferencesStore, type Preferences } from "./preferencesStore";
import { refreshScene } from "./sceneStore";
import { useSessionStore } from "./sessionStore";
import { hostPort } from "../lib/hostPort";

interface SettingsDraft {
  preferences: Partial<Preferences>;
  providerId: ProviderId | null;
  providerOptions: Record<ProviderId, Record<string, string>>;
  settings: Partial<AppSettings>;
  plugins: Record<string, Record<string, unknown>>;
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  resetPreferences: () => void;
  setProviderId: (id: ProviderId) => void;
  setProviderOption: (id: ProviderId, key: string, value: string) => void;
  patchSettings: (patch: Partial<AppSettings>) => void;
  setPluginValues: (id: string, values: Record<string, unknown>) => void;
  discard: () => void;
}

const EMPTY = {
  preferences: {},
  providerId: null,
  providerOptions: {},
  settings: {},
  plugins: {},
};

export const useSettingsDraft = create<SettingsDraft>((set) => ({
  ...EMPTY,
  setPreference: (key, value) =>
    set((s) => ({ preferences: { ...s.preferences, [key]: value } })),
  resetPreferences: () => set({ preferences: { ...DEFAULTS } }),
  setProviderId: (id) => set({ providerId: id }),
  setProviderOption: (id, key, value) =>
    set((s) => ({
      providerOptions: {
        ...s.providerOptions,
        [id]: { ...s.providerOptions[id], [key]: value },
      },
    })),
  patchSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  setPluginValues: (id, values) =>
    set((s) => ({ plugins: { ...s.plugins, [id]: values } })),
  discard: () => set({ ...EMPTY }),
}));

export function useDraftPreference<K extends keyof Preferences>(key: K): Preferences[K] {
  const pending = useSettingsDraft((s) => s.preferences);
  const committed = usePreferencesStore((s) => s[key]);
  return key in pending ? (pending[key] as Preferences[K]) : committed;
}

export function useDraftSettings(): AppSettings | null {
  const committed = useSessionStore((s) => s.settings);
  const pending = useSettingsDraft((s) => s.settings);
  return useMemo(
    () => (committed ? { ...committed, ...pending } : null),
    [committed, pending],
  );
}

export function useDraftProviderId(): ProviderId {
  const committed = useSessionStore((s) => s.providerId);
  const pending = useSettingsDraft((s) => s.providerId);
  return pending ?? committed;
}

export function useDraftProviderOptions(): Record<ProviderId, Record<string, string>> {
  const committed = useSessionStore((s) => s.providerOptions);
  const pending = useSettingsDraft((s) => s.providerOptions);
  return useMemo(() => {
    const merged = { ...committed };
    for (const [id, options] of Object.entries(pending)) {
      merged[id] = { ...committed[id], ...options };
    }
    return merged;
  }, [committed, pending]);
}

export function hasPendingChanges(draft: SettingsDraft = useSettingsDraft.getState()): boolean {
  return (
    Object.keys(draft.preferences).length > 0 ||
    draft.providerId !== null ||
    Object.keys(draft.providerOptions).length > 0 ||
    Object.keys(draft.settings).length > 0 ||
    Object.keys(draft.plugins).length > 0
  );
}

/** The data half of a draft: what a commit applies. */
type DraftChanges = Pick<
  SettingsDraft,
  "preferences" | "providerId" | "providerOptions" | "settings" | "plugins"
>;

/**
 * Apply a draft to the live stores. It reads back what it just wrote (the
 * devices, barge-in), so it runs where the stores live: in the owner window,
 * even when the settings were edited in the panel.
 */
const applyDraft = ownerCall("settings.commit", async (draft: DraftChanges): Promise<void> => {
  const prefs = usePreferencesStore.getState();
  const session = useSessionStore.getState();
  if ("language" in draft.preferences || "wakePhrase" in draft.preferences) {
    await hostPort()?.savePreferences?.({ language: draft.preferences.language ?? prefs.language, wakePhrase: draft.preferences.wakePhrase ?? prefs.wakePhrase, wakeWord: draft.preferences.wakeWord ?? prefs.wakeWord });
  }

  for (const key of Object.keys(draft.preferences) as (keyof Preferences)[]) {
    prefs.setPreference(key, draft.preferences[key] as never);
  }
  const next = usePreferencesStore.getState();
  if ("bargeIn" in draft.preferences || "bargeInSensitivity" in draft.preferences) {
    session.applyBargeIn(next.bargeIn, next.bargeInSensitivity);
  }
  if ("micDeviceId" in draft.preferences) await session.applyInputDevice(next.micDeviceId);
  if ("speakerDeviceId" in draft.preferences) {
    await session.applyOutputDevice(next.speakerDeviceId);
  }

  if (draft.providerId !== null && draft.providerId !== session.providerId) {
    session.setProviderId(draft.providerId);
  }
  for (const [id, options] of Object.entries(draft.providerOptions)) {
    for (const [key, value] of Object.entries(options)) {
      useSessionStore.getState().setProviderOption(id, key, value);
    }
  }

  const settings = useSessionStore.getState().settings;
  if (settings && Object.keys(draft.settings).length > 0) {
    await useSessionStore.getState().saveSettings({ ...settings, ...draft.settings });
  }

  const pluginIds = Object.keys(draft.plugins);
  for (const id of pluginIds) {
    await setPluginSettings(id, draft.plugins[id]);
  }
  if (pluginIds.length > 0) {
    await Promise.all([usePluginsStore.getState().refresh(), refreshScene()]);
  }
});

export async function commitSettingsDraft(): Promise<void> {
  const { preferences, providerId, providerOptions, settings, plugins } =
    useSettingsDraft.getState();
  await applyDraft({ preferences, providerId, providerOptions, settings, plugins });
  useSettingsDraft.getState().discard();
}
