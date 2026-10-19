import { describe, expect, it } from "vitest";
import { pluginPresentation } from "./pluginPresentation";

describe("plugin presentation", () => {
  it("uses primary-language labels for a region-specific contributed locale", () => {
    expect(pluginPresentation({ name: "Notebook", localized: { es: { name: "Notas", description: "Memoria" } } }, "es-es")).toEqual({ name: "Notas", description: "Memoria" });
  });
  it("uses the plugin's translated name and description", () => {
    const localized = { name: "Saved music", description: "Previously played songs." };
    expect(pluginPresentation({ name: "Music history", localized: { pt: localized } }, "pt")).toEqual(localized);
  });

  it("keeps older plugins renderable when descriptions or translations are missing", () => {
    expect(pluginPresentation({ name: "Third-party plugin" }, "it")).toEqual({ name: "Third-party plugin", description: "" });
    expect(pluginPresentation({ name: "Music history", description: "Previously played songs.", localized: { pt: { name: " ", description: " " } } }, "pt"))
      .toEqual({ name: "Music history", description: "Previously played songs." });
  });
});
