import { describe, expect, it } from "vitest";
import { localizedPluginUi, localizedPluginItem } from "./pluginLocalization";
import type { PluginUi } from "../types";

describe("plugin UI localization", () => {
  const ui: PluginUi = {
    localized: { es: { Notes: "Notas", Ready: "Listo", Refresh: "Actualizar", Empty: "Vacío" } },
    settings: [{ key: "Notes", kind: "select", label: "Notes", default: "Ready",
      options: [{ value: "Ready", label: "Ready" }] }],
    status: [{ label: "Notes", value: "Ready" }],
    actions: [{ label: "Refresh", tool: "Refresh", args: { value: "Ready" } }],
    list: { title: "Notes", tool: "notes_list", empty: "Empty" },
    lists: [{ title: "Notes", tool: "review_today", empty: "Empty" }],
    cards: [{title:"Notes",tool:"notes_card"}],
    progress: [{title:"Ready",tool:"progress",max:10}],
    forms: [{title:"Notes",tool:"save",submitLabel:"Refresh",fields:[{key:"q",label:"Notes",kind:"select",options:[{value:"Ready",label:"Ready"}]}]}],
  };

  it("translates display fields without changing tool calls or stored values", () => {
    const translated = localizedPluginUi(ui, "es-ES");
    expect(translated.settings[0]).toMatchObject({ key: "Notes", label: "Notas", default: "Ready",
      options: [{ value: "Ready", label: "Listo" }] });
    expect(translated.actions[0]).toEqual({ label: "Actualizar", tool: "Refresh", args: { value: "Ready" } });
    expect(translated.list).toEqual({ title: "Notas", tool: "notes_list", empty: "Vacío" });
    expect(translated.lists).toEqual([{ title: "Notas", tool: "review_today", empty: "Vacío" }]);
    expect(translated.cards).toEqual([{title:"Notas",tool:"notes_card"}]);
    expect(translated.forms?.[0].fields[0].options).toEqual([{value:"Ready",label:"Listo"}]);
    expect(ui.actions[0].label).toBe("Refresh");
  });

  it("localizes dynamic rows with the same dictionary", () => {
    expect(localizedPluginItem(ui, "es", { label: "Notes", detail: "Ready",
      action: { label: "Refresh", tool: "Refresh" } })).toEqual({ label: "Notas", detail: "Listo",
        action: { label: "Actualizar", tool: "Refresh" } });
    expect(localizedPluginUi(ui, "fr").status).toEqual(ui.status);
  });

  it("uses a regional override and keeps primary-language translations for other labels", () => {
    const regional = { ...ui, localized: { ...ui.localized, "es-MX": { Notes: "Mis notas" } } };
    expect(localizedPluginUi(regional, "es-mx").status).toEqual([{ label: "Mis notas", value: "Listo" }]);
  });
});
