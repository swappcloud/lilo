import { describe, expect, it } from "vitest";

import {
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_VOICE,
  claudeLanguage,
  claudeVoicesFor,
  normalizeClaudeSpeed,
  normalizeClaudeVoice,
  resolveClaudeVoice,
} from "./voiceCatalog";

describe("Claude catalog", () => {
  it("defaults to the cheapest model on the list", () => {
    expect(CLAUDE_MODELS[0].id).toBe(DEFAULT_CLAUDE_MODEL);
    expect(DEFAULT_CLAUDE_MODEL).toBe("claude-haiku-4-5-20251001");
  });

  it("keeps the captured voice as the default", () => {
    expect(DEFAULT_CLAUDE_VOICE).toBe("buttery");
    expect(claudeVoicesFor("en-US").map((v) => v.id)).toContain(DEFAULT_CLAUDE_VOICE);
  });

  it("replaces a voice it does not know with the default", () => {
    expect(normalizeClaudeVoice("buttery")).toBe("buttery");
    expect(normalizeClaudeVoice("pt-BR-clara")).toBe("pt-BR-clara");
    expect(normalizeClaudeVoice("typed by hand")).toBe(DEFAULT_CLAUDE_VOICE);
    expect(normalizeClaudeVoice(undefined)).toBe(DEFAULT_CLAUDE_VOICE);
  });

  it("offers a smarter option without making it the default", () => {
    expect(CLAUDE_MODELS.length).toBeGreaterThan(1);
    expect(CLAUDE_MODELS.some((m) => m.id === "claude-sonnet-4-6")).toBe(true);
  });
});

describe("Claude voice language", () => {
  it("maps tags the way claude.ai's client does", () => {
    expect(claudeLanguage("pt-BR")).toBe("pt");
    expect(claudeLanguage("pt-PT")).toBe("pt-PT");
    expect(claudeLanguage("en-US")).toBe("en-US");
    expect(claudeLanguage("it-IT")).toBe("it");
    expect(claudeLanguage("es-419")).toBe("es-419");
    expect(claudeLanguage("xx-YY")).toBe("en");
    expect(claudeLanguage(undefined)).toBe("en");
  });

  it("offers each language its own voices", () => {
    expect(claudeVoicesFor("pt-BR").map((v) => v.id)).toEqual(["pt-BR-clara", "pt-BR-suave"]);
    expect(claudeVoicesFor("it-IT").map((v) => v.id)).toEqual(["it-dolce", "it-chiara"]);
    expect(claudeVoicesFor("zh-TW")[0].id).toBe("zh-CN-rouhe");
    // No voices of its own: claude.ai falls back to the English ones.
    expect(claudeVoicesFor("pl-PL")[0].id).toBe("buttery");
  });

  it("never sends a voice that does not speak the session language", () => {
    expect(resolveClaudeVoice("pt-BR-suave", "pt-BR")).toBe("pt-BR-suave");
    expect(resolveClaudeVoice("buttery", "pt-BR")).toBe("pt-BR-clara");
    expect(resolveClaudeVoice("pt-BR-suave", "en-US")).toBe("buttery");
    expect(resolveClaudeVoice("glassy", "en-GB")).toBe("glassy");
  });

  it("keeps speed on claude.ai's presets", () => {
    expect(normalizeClaudeSpeed("1.2")).toBe("1.2");
    expect(normalizeClaudeSpeed("3")).toBe("1");
    expect(normalizeClaudeSpeed(undefined)).toBe("1");
  });
});
