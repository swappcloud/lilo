import { syncPluginProviders } from "../providers/plugins/registry";
import { create } from "zustand";

import {
  hasHost,
  listPlugins,
  pluginUninstall,
  setPluginEnabled,
} from "../lib/gateway";
import type { PluginView } from "../types";
import { installPluginLanguages } from "../i18n/pluginLanguages";

/**
 * The installed plugins, shared by the Plugins page and the settings
 * navigation.
 *
 * Both need the same list: the page to switch a plugin on or off, the
 * navigation to give a plugin with settings its own page. One store keeps them
 * from refreshing at different times and disagreeing.
 */
interface PluginsStore {
  plugins: PluginView[];
  /** False until the first read finishes, so the page does not flash "none". */
  loaded: boolean;
  /** Set when the list could not be read; the page shows it. */
  error: string | null;
  refresh: () => Promise<void>;
  /** Deactivates it or brings it back, then re-reads the list. */
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Removes it and everything it owns, then re-reads the list. */
  uninstall: (id: string) => Promise<void>;
}

export const usePluginsStore = create<PluginsStore>((set, get) => ({
  plugins: [],
  loaded: false,
  error: null,

  refresh: async () => {
    if (!hasHost()) return;
    try {
      const plugins = await listPlugins();
      set({ plugins, error: null, loaded: true });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        loaded: true,
      });
    }
  },

  setEnabled: async (id, enabled) => {
    await setPluginEnabled(id, enabled);
    await get().refresh();
  },

  uninstall: async (id) => {
    await pluginUninstall(id);
    await get().refresh();
  },
}));

// Also handles state mirrored into the panel window and test/store resets.
usePluginsStore.subscribe((state, previous) => {
  if (state.plugins !== previous.plugins) {
    syncPluginProviders(state.plugins);
    installPluginLanguages(state.plugins);
  }
});
