import { afterEach, describe, expect, it } from "vitest";
import { installPluginLanguages, pluginLanguages, pluginDictionary } from "./pluginLanguages";
import { translateIn } from "./translate";
import { uiLocale, replyLanguageDirective } from "../store/language";
import type { PluginView } from "../types";

function pack(id = "com.example.spanish", loaded = true): PluginView {
  return {
    manifest: { id, name: id, api: 1, version: "1.0.0", capabilities: [],
      languages: [{ tag: "es-ES", name: "Español", messages: {
        "language.title": "Idioma", "language.help": "Idioma: {language}",
      } }] },
    enabled: true, loaded, manageable: true,
    tools: [],
    ui: { settings: [], status: [], actions: [] },
  };
}

afterEach(() => installPluginLanguages([]));

describe("plugin language contributions", () => {
  it("adds a selectable locale with interpolation and English fallback", () => {
    installPluginLanguages([pack()]);
    expect(pluginLanguages()).toEqual([{ tag: "es-ES", name: "Español", owner: "com.example.spanish" }]);
    expect(uiLocale("es-ES")).toBe("es-es");
    expect(uiLocale("es-MX")).toBe("es-es");
    expect(translateIn("es-es", "language.title")).toBe("Idioma");
    expect(translateIn("es-es", "language.help", { language: "Español" })).toBe("Idioma: Español");
    expect(translateIn("es-es", "plugins.title")).toBe(translateIn("en", "plugins.title"));
  });

  it("removes contributions when a plugin is disabled or unloaded", () => {
    installPluginLanguages([pack()]);
    installPluginLanguages([pack("com.example.spanish", false)]);
    expect(pluginLanguages()).toEqual([]);
    expect(uiLocale("es-ES")).toBe("en");
  });

  it("selects an exact region before falling back to another pack", () => {
    const plugin = pack();
    plugin.manifest.languages!.push({ tag: "es-MX", name: "Español mexicano", messages: { "language.title": "Idioma mexicano" } });
    installPluginLanguages([plugin]);
    expect(uiLocale("es-MX")).toBe("es-mx");
    expect(translateIn("es-mx", "language.title")).toBe("Idioma mexicano");
    expect(uiLocale("es-AR")).toBe("es-es");
  });

  it("never replaces built-in languages and resolves conflicts by plugin id", () => {
    const spanish = pack("z.spanish");
    const preferred = pack("a.spanish");
    preferred.manifest.languages![0].messages["language.title"] = "Primero";
    spanish.manifest.languages!.push({ tag: "en-US", name: "Fake English", messages: { "language.title": "Hijacked" } });
    installPluginLanguages([spanish, preferred]);
    expect(translateIn("es-es", "language.title")).toBe("Primero");
    expect(pluginDictionary("en-us")).toBeUndefined();
  });

  it("rejects malformed tags, unknown keys and mismatched placeholders", () => {
    const plugin = pack();
    plugin.manifest.languages![0].messages["language.help"] = "Wrong {secret}";
    plugin.manifest.languages![0].messages["not.a.host.key"] = "Unknown";
    plugin.manifest.languages!.push({ tag: "../bad", name: "Bad", messages: {} });
    installPluginLanguages([plugin]);
    expect(pluginLanguages()).toHaveLength(1);
    expect(pluginDictionary("es-es")?.["language.help"]).toBeUndefined();
    expect(pluginDictionary("es-es")?.["not.a.host.key"]).toBeUndefined();
  });

  it("anchors explicitly selected contributed languages", () => {
    expect(replyLanguageDirective("es-ES")).toContain("only in European Spanish");
    expect(replyLanguageDirective("es-ES")).not.toContain("language I am speaking");
  });
});
