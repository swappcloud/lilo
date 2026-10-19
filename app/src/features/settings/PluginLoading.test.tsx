import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { PluginView } from "../../types";

const mocks = vi.hoisted(() => ({ run: vi.fn(), event: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../../lib/gateway", () => ({ isTauri: () => true, hasHost: () => true, runTool: mocks.run, onPluginEvent: mocks.event, pluginImage: vi.fn(), pluginSettings: vi.fn() }));
vi.mock("../../store/sessionStore", () => ({ useSessionStore: (select: (s: unknown) => unknown) => select({ runTool: mocks.run }) }));
vi.mock("../../store/pluginsStore", () => ({ usePluginsStore: (select: (s: unknown) => unknown) => select({ setSettings: vi.fn() }) }));
vi.mock("../../store/settingsDraft", () => ({ useSettingsDraft: (select: (s: unknown) => unknown) => select({}) }));
vi.mock("../../store/sceneStore", () => ({ refreshScene: vi.fn() }));
import { pluginPages } from "./sections";

const plugin: PluginView = {
  manifest: { id: "gallery", name: "Image gallery", api: 1, version: "1.0.0", capabilities: [] },
  enabled: true, loaded: true, manageable: true, tools: ["gallery_list"],
  ui: { settings: [], status: [], actions: [], list: { title: "Images", tool: "gallery_list", empty: "No images yet" } },
};

describe("asynchronous sidebar plugin pages", () => {
  it("shows a skeleton instead of an empty result and retains loaded content across plugin updates", async () => {
    let complete!: (value: unknown) => void;
    mocks.run.mockReset().mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const element = document.createElement("div");
    const root = createRoot(element);
    const render = (source: PluginView) => {
      const page = pluginPages([source])[0];
      const Component = page.Component;
      return <Component plugin={page.plugin} onNavigate={() => {}} />;
    };
    try {
      await act(async () => root.render(render(plugin)));
      expect(element.querySelector(".content-skeleton")).not.toBeNull();
      expect(element.textContent).not.toContain("No images yet");
      expect(element.querySelector('[aria-busy="true"]')).not.toBeNull();
      await act(async () => complete({ items: [{ label: "Saved image" }] }));
      expect(element.querySelector(".content-skeleton")).toBeNull();
      expect(element.textContent).toContain("Saved image");
      await act(async () => root.render(render({ ...plugin, ui: { ...plugin.ui, status: [{ label: "Images", value: "1", state: "ok" }] } })));
      expect(element.textContent).toContain("Saved image");
      expect(element.querySelector(".content-skeleton")).toBeNull();
      expect(mocks.run).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
