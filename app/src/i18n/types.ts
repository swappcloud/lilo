/** Shared i18n types. Kept dependency-free so any module can import it. */

export type BuiltinUILocale = "en" | "pt" | "it";
export type UILocale = string;

export type Vars = Record<string, string | number>;

/** Per-domain message set: the English source plus each translation. */
export interface MessagePair<En extends Record<string, string>> {
  en: En;
  pt: Record<keyof En, string>;
  it: Record<keyof En, string>;
}

/** Declare a domain's messages, checking every translation against English. */
export function messages<const En extends Record<string, string>>(pair: {
  en: En;
  pt: Record<keyof En, string>;
  it: Record<keyof En, string>;
}): MessagePair<En> {
  return pair;
}
