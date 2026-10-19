import { beforeEach, describe, expect, it } from "vitest";

import {
  applyRustOptionMirrors,
  clearProvidersForTests,
  defaultProviderId,
  isProviderId,
  loginProviderIds,
  normalizeProviderOptions,
  providerIds,
  registerProvider,
  type ProviderDefinition,
} from "./contract";
import type { AppSettings } from "../types";

function fake(id: string, extra: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    id,
    icon: () => null,
    shortLabel: id,
    label: id,
    description: "",
    selectable: true,
    requiresAccount: false,
    capabilities: { voice: false, voiceMode: false, login: false, phoneLogin: false, usage: false },
    protocol: {
      inbound: { userText: true, assistantText: true, nativeToolCalls: false, images: false },
      outbound: { text: true, stopSpeaking: true, systemPrompt: true, toolResult: false, image: false },
    },
    settings: [],
    optionDefaults: {},
    create: () => {
      throw new Error("not used");
    },
    ...extra,
  };
}

describe("provider registry", () => {
  beforeEach(() => clearProvidersForTests());

  it("is a valid, empty state with no backends", () => {
    expect(providerIds()).toEqual([]);
    expect(defaultProviderId()).toBeUndefined();
    expect(isProviderId("chatgpt-web")).toBe(false);
  });

  it("knows only what was registered, once", () => {
    registerProvider(fake("a"));
    expect(isProviderId("a")).toBe(true);
    expect(isProviderId("b")).toBe(false);
    expect(() => registerProvider(fake("a"))).toThrow();
  });

  it("falls back to a backend that needs no account", () => {
    registerProvider(fake("paid", { requiresAccount: true }));
    registerProvider(fake("free"));
    expect(defaultProviderId()).toBe("free");
  });

  it("lists sign-in backends from their declarations", () => {
    registerProvider(fake("a"));
    registerProvider(fake("b", { login: { selectOnSuccess: true } }));
    expect(loginProviderIds()).toEqual(["b"]);
  });

  it("lets each owner repair its stored options", () => {
    registerProvider(
      fake("a", {
        optionDefaults: { voice: "one" },
        normalizeOptions: (o) => ({ ...o, voice: o.voice === "bad" ? "one" : o.voice }),
      }),
    );
    registerProvider(fake("b", { optionDefaults: { mode: "x" } }));
    const options = normalizeProviderOptions({ a: { voice: "bad" }, gone: { k: "v" } });
    expect(options).toEqual({ a: { voice: "one" }, b: { mode: "x" } });
  });

  it("folds Rust-owned settings into their owner only", () => {
    registerProvider(
      fake("a", {
        optionDefaults: { voice: "one" },
        rustOptionMirrors: { voice: { setting: "defaultVoice" } },
      }),
    );
    registerProvider(fake("b", { optionDefaults: { voice: "two" } }));
    const next = applyRustOptionMirrors(
      { a: { voice: "one" }, b: { voice: "two" } },
      { defaultVoice: "ember" } as AppSettings,
    );
    expect(next).toEqual({ a: { voice: "ember" }, b: { voice: "two" } });
  });
});
