import { beforeEach, describe, expect, it, vi } from "vitest";

const setPluginSettings = vi.fn();

vi.mock("../lib/gateway", async (original) => ({
  ...(await original<typeof import("../lib/gateway")>()),
  isTauri: () => false,
  setPluginSettings: (id: string, values: Record<string, unknown>) =>
    setPluginSettings(id, values),
}));

import { DEFAULTS, usePreferencesStore } from "./preferencesStore";
import {
  commitSettingsDraft,
  hasPendingChanges,
  useSettingsDraft,
} from "./settingsDraft";

describe("settings draft", () => {
  beforeEach(() => {
    localStorage.clear();
    usePreferencesStore.getState().reset();
    useSettingsDraft.getState().discard();
    setPluginSettings.mockReset();
  });

  it("changes nothing until Done", () => {
    useSettingsDraft.getState().setPreference("accent", "sunset");
    useSettingsDraft.getState().setPreference("theme", "light");

    expect(usePreferencesStore.getState().accent).toBe(DEFAULTS.accent);
    expect(usePreferencesStore.getState().theme).toBe(DEFAULTS.theme);
    expect(hasPendingChanges()).toBe(true);
  });

  it("applies every staged preference on Done and clears the draft", async () => {
    useSettingsDraft.getState().setPreference("accent", "sunset");
    useSettingsDraft.getState().setPreference("theme", "light");

    await commitSettingsDraft();

    expect(usePreferencesStore.getState().accent).toBe("sunset");
    expect(usePreferencesStore.getState().theme).toBe("light");
    expect(hasPendingChanges()).toBe(false);
  });

  it("throws the staged changes away when closed without Done", () => {
    useSettingsDraft.getState().setPreference("accent", "sunset");
    useSettingsDraft.getState().discard();

    expect(usePreferencesStore.getState().accent).toBe(DEFAULTS.accent);
    expect(hasPendingChanges()).toBe(false);
  });

  it("stages Reset as defaults instead of applying it", async () => {
    usePreferencesStore.getState().setPreference("accent", "sunset");
    useSettingsDraft.getState().resetPreferences();

    expect(usePreferencesStore.getState().accent).toBe("sunset");
    await commitSettingsDraft();
    expect(usePreferencesStore.getState().accent).toBe(DEFAULTS.accent);
  });

  it("saves staged plugin settings only on Done", async () => {
    useSettingsDraft.getState().setPluginValues("lilo.weather", { effect: "rain" });
    expect(setPluginSettings).not.toHaveBeenCalled();

    await commitSettingsDraft();

    expect(setPluginSettings).toHaveBeenCalledWith("lilo.weather", { effect: "rain" });
  });
});
