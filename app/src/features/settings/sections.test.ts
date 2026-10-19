import { describe, expect, it } from "vitest";

import type { PluginView } from "../../types";
import { pluginPageId } from "./PluginPage";
import { pluginPages, SETTINGS_GROUPS, SETTINGS_PAGES } from "./sections";

it("keeps every settings page reachable in exactly one navigation group", () => {
  const groups = new Set(SETTINGS_GROUPS.map((group) => group.id));
  const pages = [...SETTINGS_PAGES, ...pluginPages([view("com.acme.notes", { ui: withSettings })])];
  expect(new Set(pages.map((page) => page.id)).size).toBe(pages.length);
  for (const page of pages) expect(groups.has(page.group)).toBe(true);
  expect(pages.find((page) => page.id === "diagnostics")?.group).toBe("application");
  expect(pages.find((page) => page.id === pluginPageId("com.acme.notes"))?.group).toBe("plugins");
});

function view(id: string, overrides: Partial<PluginView> = {}): PluginView {
  return {
    manifest: { id, name: id, version: "1.0.0", api: 1, capabilities: [] },
    tools: [],
    ui: { settings: [], status: [], actions: [] },
    manageable: true,
    enabled: true,
    loaded: true,
    ...overrides,
  };
}

const withSettings = {
  settings: [{ key: "city", kind: "text" as const, label: "City" }],
  status: [],
  actions: [],
};

describe("pluginPages", () => {
  it("gives a page to active plugins that have something to show", () => {
    const pages = pluginPages([
      view("core.thing"),
      view("com.acme.off", { enabled: false, loaded: false, ui: withSettings }),
      view("com.acme.dead", { enabled: true, loaded: false, ui: withSettings }),
      view("com.acme.notes", { ui: withSettings }),
    ]);

    expect(pages.map((page) => page.id)).toEqual([pluginPageId("com.acme.notes")]);
    expect(pages[0].label).toBe("com.acme.notes");
  });

  it("brings status and actions to a page too", () => {
    const pages = pluginPages([
      view("com.acme.status", {
        ui: {
          settings: [],
          status: [{ label: "Account", value: "connected", state: "ok" }],
          actions: [],
        },
      }),
    ]);
    expect(pages).toHaveLength(1);
  });

  it("brings a page for a live list alone", () => {
    const pages = pluginPages([
      view("com.lilo.history", {
        ui: {
          settings: [],
          status: [],
          actions: [],
          list: { title: "Recently played", tool: "history_list" },
        },
      }),
    ]);
    expect(pages).toHaveLength(1);
  });
});
