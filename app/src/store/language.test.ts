import { describe, expect, it } from "vitest";

import { replyLanguageDirective } from "./language";

describe("replyLanguageDirective", () => {
  it("expresses language preferences without assumptions about the speaker's accent", () => {
    for (const locale of ["en-US", "pt-BR", "it-IT", "fr-FR"]) {
      for (const preference of [locale, "auto"]) {
        expect(replyLanguageDirective(preference, locale)).not.toMatch(/accent|sotaque|accento/i);
      }
    }
    expect(replyLanguageDirective("auto", "en-US")).toContain("unless I ask you to");
  });
  it("anchors where an automatic conversation starts", () => {
    const directive = replyLanguageDirective("auto", "en-US");
    expect(directive).toContain("start in American English");
    expect(directive).toContain("language I am speaking");
  });

  it("is written in Portuguese when the conversation starts in Portuguese", () => {
    const directive = replyLanguageDirective("auto", "pt-BR");
    expect(directive).toContain("português brasileiro");
    expect(directive).not.toContain("Important:");
  });

  it("keeps explicit languages fixed", () => {
    expect(replyLanguageDirective("en-US")).toContain("only in English");
    expect(replyLanguageDirective("pt-BR")).toContain("somente em português");
    expect(replyLanguageDirective("it-IT")).toContain("solo in italiano");
  });

  it("writes the automatic rule in the language it starts with", () => {
    expect(replyLanguageDirective("auto", "it-IT")).toContain("inizia in italiano");
    expect(replyLanguageDirective("auto", "fr-FR")).toContain("start in French");
  });
  it("allows requested language exercises while preserving the explanation language", () => {
    expect(replyLanguageDirective("en-US")).toContain("language of my request");
    expect(replyLanguageDirective("pt-BR")).toContain("idioma do meu pedido");
    expect(replyLanguageDirective("it-IT")).toContain("lingua della mia richiesta");
  });
});
