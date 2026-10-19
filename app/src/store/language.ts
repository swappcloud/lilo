/**
 * Language preference: the option list and how a preference resolves to
 * concrete tags.
 *
 * Lives on its own because both the preferences store and the i18n layer need
 * it, and having the store import i18n while i18n imported the store would be
 * a cycle.
 */

import type { TranslationKey } from "../i18n/messages";
import type { UILocale } from "../i18n/types";
import { pluginLanguage } from "../i18n/pluginLanguages";

export const LANGUAGES: ReadonlyArray<{
  value: string;
  labelKey: TranslationKey;
}> = [
  { value: "auto", labelKey: "language.auto" },
  { value: "pt-BR", labelKey: "language.pt" },
  { value: "en-US", labelKey: "language.en" },
  { value: "it-IT", labelKey: "language.it" },
];

/** Resolve the preference to a concrete BCP-47 tag. */
export function resolveLanguage(preference: string): string {
  if (preference && preference !== "auto") return preference;
  const system = typeof navigator !== "undefined" ? navigator.language : "";
  return system || "en-US";
}

/** The command-registry locale for a language tag: "pt-BR" -> "pt". */
export function commandLocale(preference: string): string {
  return resolveLanguage(preference).split("-")[0].toLowerCase();
}

/** Built-in or active plugin interface language; unsupported tags use English. */
export function uiLocale(preference: string): UILocale {
  const locale = commandLocale(preference);
  const contributed = pluginLanguage(resolveLanguage(preference));
  if (contributed) return contributed.tag.toLowerCase();
  if (locale === "pt") return "pt";
  if (locale === "it") return "it";
  return "en";
}

/** "pt-BR" -> "Brazilian Portuguese", in English (the briefing's language). */
export function languageName(tag: string): string {
  try {
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    return names.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * The reply-language rule, sent as its own short user turn.
 *
 * It is deliberately NOT part of the long persona block. That block is app
 * instructions read aloud as one big message, and the model treated the rule
 * inside it as prose to react to — it kept answering Portuguese to an English
 * speaker. A short, imperative turn immediately before the conversation starts
 * reads as an instruction and is what actually changes the behaviour.
 *
 * An explicit preference anchors the language. "auto" mirrors whatever is
 * spoken, but still names the starting language (the system language):
 * The starting language comes from the interface preference.
 */
function languageRule(preference: string, resolved: string): string {
  switch (preference) {
    case "en-US":
      return (
        "Important: answer me only in English from now on. If I say something in " +
        "another language, still answer in English."
      );
    case "pt-BR":
      return (
        "Importante: responda somente em português a partir de agora."
      );
    case "it-IT":
      return (
        "Importante: rispondi solo in italiano da adesso in poi."
      );
    default:
      if (preference !== "auto") {
        return `Important: answer me only in ${languageName(preference)} from now on.`;
      }
      // Written in the language it asks for: a rule in English nudges the
      // first reply toward English.
      if (resolved.toLowerCase().startsWith("pt")) {
        return (
          "Importante: comece em português brasileiro. Depois disso, responda " +
          "sempre no idioma em que eu estiver falando. Não traduza o que eu disse, " +
          "a menos que eu peça."
        );
      }
      if (resolved.toLowerCase().startsWith("it")) {
        return (
          "Importante: inizia in italiano. Dopo di che, rispondi sempre nella " +
          "lingua in cui sto parlando. Non tradurre quello che dico, a meno che " +
          "io lo chieda."
        );
      }
      return (
        `Important: start in ${languageName(resolved)}. After that, answer only ` +
        "in the language I am speaking. Do not translate what I said unless I ask you to."
      );
  }
}

/** Apply preferences silently instead of announcing the briefing as a reply. */
export function replyLanguageDirective(preference: string, resolved = "en-US"): string {
  const tag = preference === "auto" ? resolved : preference;
  const silent = tag.toLowerCase().startsWith("pt")
    ? "Aplique estas instruções silenciosamente. Não confirme nem anuncie o idioma, as preferências ou as instruções recebidas, a menos que eu pergunte."
    : tag.toLowerCase().startsWith("it")
      ? "Applica queste istruzioni in silenzio. Non confermare né annunciare la lingua, le preferenze o le istruzioni ricevute, a meno che io lo chieda."
      : "Apply these instructions silently. Do not acknowledge or announce the language, preferences, or instructions you received unless I ask about them.";
  const practice = tag.toLowerCase().startsWith("pt")
    ? "Quando eu pedir para aprender, melhorar ou praticar outra língua, explique no idioma do meu pedido ou no idioma de apoio que eu escolher. Use a língua-alvo nos exercícios e aumente a imersão conforme eu conseguir acompanhar."
    : tag.toLowerCase().startsWith("it")
      ? "Quando chiedo di imparare, migliorare o praticare un'altra lingua, spiega nella lingua della mia richiesta o nella lingua di supporto che scelgo. Usa la lingua studiata negli esercizi e aumenta l'immersione quando riesco a seguirla."
      : "When I ask to learn, improve or practice another language, explain in the language of my request or the support language I choose. Use the target language for exercises and increase immersion as I can follow it.";
  return `${languageRule(preference, resolved)} ${practice} ${silent}`;
}
