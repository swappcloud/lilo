/**
 * Minimal in-house i18n.
 *
 * The app ships built-in languages and accepts plugin language packs; a
 * plain lookup plus one `t()` is all that is needed. The rule that matters is
 * that *every* visible string goes through here, so switching the language
 * changes the whole interface and not just the conversation.
 *
 * The string data lives in `./messages` (split per feature) and the pure
 * lookup in `./translate`; this module only adds the React hook.
 */

import { useCallback } from "react";

import { usePreferencesStore } from "../store/preferencesStore";
import { uiLocale } from "../store/language";
import type { TranslationKey } from "./messages";
import type { UILocale, Vars } from "./types";
import { translateIn } from "./translate";
import { usePluginLanguages } from "./pluginLanguages";

export type { TranslationKey, UILocale, Vars };
export { translateIn };

/** Translate using the user's current preference (non-reactive). */
export function translate(key: TranslationKey, vars?: Vars): string {
  return translateIn(uiLocale(usePreferencesStore.getState().language), key, vars);
}

export type Translate = (key: TranslationKey, vars?: Vars) => string;

/**
 * The hook components use. Subscribes to the language preference so flipping
 * it re-renders every localized string in place.
 */
export function useTranslation(): { t: Translate; locale: UILocale } {
  const contributions = usePluginLanguages((s) => s.entries);
  const language = usePreferencesStore((s) => s.language);
  const locale = uiLocale(language);
  // Stable across renders: hooks that depend on `t` must not resubscribe or
  // reset their timers on every paint.
  const t = useCallback<Translate>(
    (key, vars) => translateIn(locale, key, vars),
    [locale, contributions],
  );
  return { t, locale };
}
