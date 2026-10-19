import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("../../store/pluginsStore", () => ({
  usePluginsStore: (select: (state: unknown) => unknown) => select({ plugins: [], refresh: async () => {} }),
}));

it("offers compact section navigation only when the host requests it", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(<SettingsPanel open onClose={() => {}} pageIds={["language"]} compactNavigation/>));
  const select = element.querySelector<HTMLSelectElement>(".settings-compact-nav select")!;
  expect(select).not.toBeNull();
  expect(select.querySelector('option[value="language"]')).not.toBeNull();
  await act(async () => { select.value = "language"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(element.querySelector(".settings-head h2")?.textContent).toBe("Language");
  await act(async () => root.render(<SettingsPanel open onClose={() => {}} pageIds={["language"]}/>));
  expect(element.querySelector(".settings-compact-nav")).toBeNull();
  await act(async () => root.unmount());
  element.remove();
});
