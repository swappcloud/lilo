/**
 * Pure translation: locale + key -> string.
 *
 * No React and no store, so non-component code (the preferences store seeding
 * defaults, the session store emitting toasts) can localize without creating
 * an import cycle through the hook.
 */

import { DICTIONARIES, EN, type TranslationKey } from "./messages";
import type { UILocale, Vars } from "./types";
import { pluginDictionary } from "./pluginLanguages";

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

export function translateIn(
  locale: UILocale,
  key: TranslationKey,
  vars?: Vars,
): string {
  const dictionary = Object.hasOwn(DICTIONARIES, locale)
    ? DICTIONARIES[locale as keyof typeof DICTIONARIES]
    : pluginDictionary(locale) ?? EN;
  return interpolate(dictionary[key] ?? EN[key] ?? key, vars);
}
