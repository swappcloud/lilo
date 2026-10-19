import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gateway = vi.hoisted(() => ({ setCommandLocales: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/gateway", () => ({
  isTauri: () => true,
  setAssistantName: vi.fn().mockResolvedValue(undefined),
  setCommandLocales: gateway.setCommandLocales,
}));

async function loadWith(stored: Record<string, unknown> | null, version?: string) {
  localStorage.clear();
  if (stored) localStorage.setItem("lilo/preferences", JSON.stringify(stored));
  if (version) localStorage.setItem("lilo/preferences-version", version);
  vi.resetModules();
  const mod = await import("./preferencesStore");
  return mod.usePreferencesStore;
}

describe("preferences visualizer migration", () => {
  it("keeps commands available in every declared language when the reply language changes", async () => {
    const store = await loadWith({ language: "en-US" });
    gateway.setCommandLocales.mockClear();
    store.getState().setPreference("language", "pt-BR");
    expect(gateway.setCommandLocales).toHaveBeenCalledWith([]);
  });
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("defaults to the LILO character", async () => {
    const store = await loadWith(null);
    expect(store.getState().viz).toBe("lilo");
  });

  it("moves the old default orb and the removed wave to LILO", async () => {
    expect((await loadWith({ viz: "orb" })).getState().viz).toBe("lilo");
    expect((await loadWith({ viz: "wave" })).getState().viz).toBe("lilo");
    expect((await loadWith({ viz: "nonsense" }, "2")).getState().viz).toBe("lilo");
  });

  it("keeps real choices", async () => {
    expect((await loadWith({ viz: "bars" })).getState().viz).toBe("bars");
    expect((await loadWith({ viz: "orb" }, "2")).getState().viz).toBe("orb");
  });

  it("a saved choice survives the next launch", async () => {
    const store = await loadWith({ viz: "orb", theme: "light" });
    store.getState().setPreference("viz", "orb");
    const reloaded = await loadWith(
      JSON.parse(localStorage.getItem("lilo/preferences") ?? "{}"),
      localStorage.getItem("lilo/preferences-version") ?? undefined,
    );
    expect(reloaded.getState().viz).toBe("orb");
    expect(reloaded.getState().theme).toBe("light");
  });
});

describe("palette, theme and localized defaults", () => {
  beforeEach(() => localStorage.clear());

  it("resolves curated and custom palettes, falling back on bad input", async () => {
    const { accentColors, ACCENTS } = await import("./preferencesStore");
    expect(accentColors({ accent: "ember", customAccent: ACCENTS.indigo })).toEqual(ACCENTS.ember);
    expect(
      accentColors({ accent: "custom", customAccent: { from: "#112233", to: "#445566" } }),
    ).toEqual({ from: "#112233", to: "#445566" });
    expect(
      accentColors({ accent: "custom", customAccent: { from: "red", to: "#445566" } }),
    ).toEqual(ACCENTS.indigo);
  });

  it("drops a stored palette or theme this build does not know", async () => {
    const store = await loadWith({ accent: "neon", theme: "sepia" });
    expect(store.getState().accent).toBe("indigo");
    expect(store.getState().theme).toBe("system");
  });

  it("follows the conversation language until the user edits the persona", async () => {
    const { effectivePersona, effectiveGreeting, DEFAULT_PERSONA } = await import(
      "./preferencesStore"
    );
    expect(effectivePersona({ systemPrompt: null, language: "en-US" })).toBe(DEFAULT_PERSONA.en);
    expect(effectivePersona({ systemPrompt: null, language: "pt-BR" })).toBe(DEFAULT_PERSONA.pt);
    expect(DEFAULT_PERSONA.en).not.toMatch(/portugu/i);
    expect(effectivePersona({ systemPrompt: "", language: "en-US" })).toBe("");
    expect(effectivePersona({ systemPrompt: "Be terse.", language: "pt-BR" })).toBe("Be terse.");
    expect(effectiveGreeting({ wakeGreeting: null, language: "pt-BR" })).toMatch(/^Oi!/);
  });

  it("turns the old shipped English persona back into the language default", async () => {
    const store = await loadWith({
      systemPrompt:
        "You are LILO — Listen In. Listen Out. — my realtime voice assistant. Always address yourself as LILO, never as ChatGPT. In Portuguese, LILO is masculine: say “o LILO”, never “a LILO”. Keep replies short, spoken and natural, and answer in the language I speak.",
      wakeGreeting: "Hi! I just activated you by voice — greet me and ask how you can help.",
    });
    expect(store.getState().systemPrompt).toBeNull();
    expect(store.getState().wakeGreeting).toBeNull();
  });
});
