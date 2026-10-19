import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AppearanceSection } from "../settings/AppearanceSection";
import { usePreferencesStore } from "../../store/preferencesStore";

vi.mock("../../lib/hostPort", () => ({ hostPort: () => ({ features: { animations: false, voicePreferences: false } }) }));

afterEach(() => { document.body.innerHTML = ""; });

it("omits animation and visualizer controls on a headless host", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(<AppearanceSection/>));
  expect(element.querySelector('[aria-label="Animations"]')).toBeNull();
  expect(element.querySelector('[aria-label="Visualizer"]')).toBeNull();
  await act(async () => root.unmount());
});

it("keeps animations off even when a saved preference or reset enables them", () => {
  usePreferencesStore.getState().setPreference("animations", true);
  expect(usePreferencesStore.getState().animations).toBe(false);
});
