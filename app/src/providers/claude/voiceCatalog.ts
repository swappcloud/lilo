/**
 * Claude's voice-mode vocabulary. The model list is ordered cheapest first:
 * voice conversations run long, so Haiku is the default and the user opts into
 * a smarter model deliberately.
 */

export interface ClaudeModelOption {
  id: string;
  label: string;
}

/**
 * `claude-haiku-4-5-20251001` is the model claude.ai's own voice mode used in
 * the captured session. `claude-sonnet-4-6` is the next tier up.
 */
export const CLAUDE_MODELS: ClaudeModelOption[] = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 — cheapest" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — smarter" },
];

/** Cheapest model; what every Claude option set starts with. */
export const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";

export interface ClaudeVoiceOption {
  id: string;
  label: string;
}

/**
 * The voices claude.ai offers in English, and in any language that has none
 * of its own (its client falls back to these the same way).
 */
const ENGLISH_VOICES: ClaudeVoiceOption[] = [
  { id: "buttery", label: "Buttery" },
  { id: "airy", label: "Airy" },
  { id: "mellow", label: "Mellow" },
  { id: "glassy", label: "Glassy" },
  { id: "rounded", label: "Rounded" },
];

/**
 * Voices per claude.ai voice-language code, as its client receives them
 * (`speech_input.supported_languages` in the account's feature config,
 * captured 2026-10). The socket's `voice` must belong to its `language`:
 * the client swaps the voice whenever the language changes.
 */
const VOICES_BY_LANGUAGE: Record<string, ClaudeVoiceOption[]> = {
  pt: [
    { id: "pt-BR-clara", label: "Clara" },
    { id: "pt-BR-suave", label: "Suave" },
  ],
  "pt-PT": [
    { id: "pt-PT-clara", label: "Clara" },
    { id: "pt-PT-suave", label: "Suave" },
  ],
  it: [
    { id: "it-dolce", label: "Dolce" },
    { id: "it-chiara", label: "Chiara" },
  ],
  es: [
    { id: "es-suave", label: "Suave" },
    { id: "es-clara", label: "Clara" },
  ],
  "es-419": [
    { id: "es-419-clara", label: "Clara" },
    { id: "es-419-suave", label: "Suave" },
  ],
  fr: [{ id: "fr-douce", label: "Douce" }],
  de: [
    { id: "de-hell", label: "Hell" },
    { id: "de-sanft", label: "Sanft" },
  ],
  // Native display names are in their own script; these are the ids' words.
  zh: [
    { id: "zh-CN-rouhe", label: "Rouhe" },
    { id: "zh-CN-mingkuai", label: "Mingkuai" },
  ],
  ja: [
    { id: "ja-maroyaka", label: "Maroyaka" },
    { id: "ja-akarui", label: "Akarui" },
  ],
  ko: [
    { id: "ko-balgeun", label: "Balgeun" },
    { id: "ko-chabunhan", label: "Chabunhan" },
  ],
  hi: [
    { id: "hi-shant", label: "Shant" },
    { id: "hi-ujjwal", label: "Ujjwal" },
  ],
  ru: [{ id: "ru-zvonkiy", label: "Zvonkiy" }],
  tr: [
    { id: "tr-yumusak", label: "Yumuşak" },
    { id: "tr-parlak", label: "Parlak" },
  ],
  uk: [
    { id: "uk-yaskravyi", label: "Yaskravyi" },
    { id: "uk-lahidnyi", label: "Lahidnyi" },
  ],
};

/**
 * BCP-47 tag -> claude.ai voice-language code, the way its client maps the
 * browser locale: a few regional variants are their own language, most
 * collapse to the base code, and anything unknown is English.
 */
const LANGUAGE_CODES: Record<string, string> = {
  "en-us": "en-US",
  "en-gb": "en-GB",
  "en-au": "en-AU",
  "en-nz": "en-NZ",
  "en-in": "en-IN",
  "pt-pt": "pt-PT",
  "es-419": "es-419",
  "zh-tw": "zh-TW",
  "zh-hk": "zh-HK",
  "de-ch": "de-CH",
  "nl-be": "nl-BE",
};

const BASE_CODES = new Set([
  "bg", "ca", "zh", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hi",
  "hu", "id", "it", "ja", "ko", "lv", "lt", "ms", "no", "pl", "pt", "ro", "ru",
  "sk", "es", "sv", "th", "tr", "uk", "vi",
]);

/** "pt-BR" -> "pt", "en-US" -> "en-US", "it-IT" -> "it". */
export function claudeLanguage(tag: string | undefined): string {
  const lower = (tag ?? "").trim().replace(/_/g, "-").toLowerCase();
  if (LANGUAGE_CODES[lower]) return LANGUAGE_CODES[lower];
  const base = lower.split("-")[0];
  return BASE_CODES.has(base) ? base : "en";
}

/** The voices offered for a conversation language (a BCP-47 tag). */
export function claudeVoicesFor(tag: string | undefined): ClaudeVoiceOption[] {
  const code = claudeLanguage(tag);
  return VOICES_BY_LANGUAGE[code] ?? VOICES_BY_LANGUAGE[code.split("-")[0]] ?? ENGLISH_VOICES;
}

export const DEFAULT_CLAUDE_VOICE = ENGLISH_VOICES[0].id;

/** Every voice LILO knows, in any language — what a stored value may be. */
const ALL_VOICES = new Set(
  [ENGLISH_VOICES, ...Object.values(VOICES_BY_LANGUAGE)].flat().map((v) => v.id),
);

/** A stored voice the catalog no longer knows falls back to the default. */
export function normalizeClaudeVoice(voice: string | undefined): string {
  return voice && ALL_VOICES.has(voice) ? voice : DEFAULT_CLAUDE_VOICE;
}

/**
 * The voice a session actually uses: the chosen one when it speaks the
 * conversation language, else that language's first voice. Switching LILO to
 * Portuguese therefore never sends an English-only voice with `language=pt`.
 */
export function resolveClaudeVoice(voice: string | undefined, tag: string | undefined): string {
  const voices = claudeVoicesFor(tag);
  return voices.find((v) => v.id === voice)?.id ?? voices[0].id;
}

/** claude.ai's speed presets, as `tts_speed` multipliers. */
export const CLAUDE_SPEEDS = [
  { value: "0.8", labelKey: "provider.speed.slow" },
  { value: "1", labelKey: "provider.speed.normal" },
  { value: "1.2", labelKey: "provider.speed.fast" },
] as const;

export const DEFAULT_CLAUDE_SPEED = "1";

export function normalizeClaudeSpeed(speed: string | undefined): string {
  return CLAUDE_SPEEDS.some((s) => s.value === speed) ? speed! : DEFAULT_CLAUDE_SPEED;
}
