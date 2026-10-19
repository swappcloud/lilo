import { beforeEach, describe, expect, it, vi } from "vitest";

const listPlugins = vi.fn();
const setPluginEnabled = vi.fn();
const pluginUninstall = vi.fn();

vi.mock("../lib/gateway", () => ({
  isTauri: () => true,
  hasHost: () => true,
  listPlugins: () => listPlugins(),
  setPluginEnabled: (id: string, enabled: boolean) => setPluginEnabled(id, enabled),
  pluginUninstall: (id: string) => pluginUninstall(id),
}));

import { usePluginsStore } from "./pluginsStore";
import type { PluginView } from "../types";
import { pluginLanguages } from "../i18n/pluginLanguages";
import { uiLocale } from "./language";

function view(id: string, enabled: boolean, loaded: boolean): PluginView {
  return {
    manifest: { id, name: id, version: "1.0.0", api: 1, capabilities: [] },
    tools: [],
    ui: { settings: [], status: [], actions: [] },
    manageable: true,
    enabled,
    loaded,
  };
}

describe("pluginsStore", () => {
  beforeEach(() => {
    listPlugins.mockReset();
    setPluginEnabled.mockReset();
    pluginUninstall.mockReset();
    usePluginsStore.setState({ plugins: [], loaded: false, error: null });
  });

  it("keeps the list a failed read did not produce", async () => {
    usePluginsStore.setState({ plugins: [view("com.acme.x", true, true)] });
    listPlugins.mockRejectedValueOnce(new Error("no host"));
    await usePluginsStore.getState().refresh();
    const state = usePluginsStore.getState();
    expect(state.error).toBe("no host");
    expect(state.plugins).toHaveLength(1);
  });

  it("updates language contributions for mirrored state as well as host reads", () => {
    const plugin = view("com.example.french", true, true);
    plugin.manifest.languages = [{ tag: "fr-FR", name: "Français", messages: { "language.title": "Langue" } }];
    usePluginsStore.setState({ plugins: [plugin] });
    expect(uiLocale("fr-FR")).toBe("fr-fr");
    expect(pluginLanguages()[0].owner).toBe("com.example.french");
    usePluginsStore.setState({ plugins: [{ ...plugin, enabled: false }] });
    expect(pluginLanguages()).toEqual([]);
    expect(uiLocale("fr-FR")).toBe("en");
  });

  it("re-reads the list after a toggle so both pages agree", async () => {
    listPlugins
      .mockResolvedValueOnce([view("com.acme.x", true, true)])
      .mockResolvedValueOnce([view("com.acme.x", false, false)]);

    await usePluginsStore.getState().refresh();
    expect(usePluginsStore.getState().plugins[0].enabled).toBe(true);

    await usePluginsStore.getState().setEnabled("com.acme.x", false);
    expect(setPluginEnabled).toHaveBeenCalledWith("com.acme.x", false);
    const off = usePluginsStore.getState().plugins[0];
    expect(off.enabled).toBe(false);
    expect(off.loaded).toBe(false);
    expect(usePluginsStore.getState().error).toBeNull();
  });

  it("uninstalls and re-reads the list", async () => {
    pluginUninstall.mockResolvedValueOnce(undefined);
    listPlugins.mockResolvedValueOnce([]);

    await usePluginsStore.getState().uninstall("com.acme.x");

    expect(pluginUninstall).toHaveBeenCalledWith("com.acme.x");
    const state = usePluginsStore.getState();
    expect(state.plugins).toEqual([]);
    expect(state.loaded).toBe(true);
  });
});
