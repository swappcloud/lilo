import { create } from "zustand";

import { isTauri, setAssistantName, setCommandLocales } from "../lib/gateway";
import { commandLocale } from "./language";
import { hostPort } from "../lib/hostPort";

/** "system" follows the OS appearance, live. */
export type ThemeMode = "system" | "dark" | "light";
export type VizMode = "lilo" | "orb" | "bars";

export interface AccentColors {
  from: string;
  to: string;
}

/**
 * Curated palettes. Each is a two-stop gradient that has to read as LILO's ink
 * on white paper (light theme) and on near-black paper (dark theme), so very
 * pale or very dark stops are out.
 */
export const ACCENTS = {
  indigo: { from: "#6366f1", to: "#a855f7" },
  ocean: { from: "#3b82f6", to: "#22d3ee" },
  lagoon: { from: "#0ea5e9", to: "#10b981" },
  mint: { from: "#14b8a6", to: "#84cc16" },
  sunset: { from: "#ec4899", to: "#f59e0b" },
  ember: { from: "#ef4444", to: "#f97316" },
  berry: { from: "#d946ef", to: "#6366f1" },
  graphite: { from: "#475569", to: "#94a3b8" },
} as const satisfies Record<string, AccentColors>;

export type PaletteKey = keyof typeof ACCENTS;
/** A curated palette, or the user's own two colours. */
export type AccentKey = PaletteKey | "custom";

const HEX = /^#[0-9a-f]{6}$/i;

/** The two colours a preference resolves to. Invalid input falls back. */
export function accentColors(
  prefs: Pick<Preferences, "accent" | "customAccent">,
): AccentColors {
  if (prefs.accent === "custom") {
    const custom = prefs.customAccent;
    if (custom && HEX.test(custom.from) && HEX.test(custom.to)) return custom;
    return ACCENTS.indigo;
  }
  return ACCENTS[prefs.accent as PaletteKey] ?? ACCENTS.indigo;
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** The theme actually painted. */
export function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode === "light" || mode === "dark") return mode;
  return systemPrefersDark() ? "dark" : "light";
}

export const VIZ_OPTIONS: ReadonlyArray<{
  value: VizMode;
  labelKey: "appearance.lilo" | "appearance.orb" | "appearance.bars";
}> = [
  { value: "lilo", labelKey: "appearance.lilo" },
  { value: "orb", labelKey: "appearance.orb" },
  { value: "bars", labelKey: "appearance.bars" },
];

export interface Preferences {
  theme: ThemeMode;
  accent: AccentKey;
  /** Used when `accent` is "custom". */
  customAccent: AccentColors;
  viz: VizMode;
  /** Master switch for aurora, ripples, pulses and canvas animation. */
  animations: boolean;
  bargeIn: boolean;
  /** 0..100 — higher is more sensitive. */
  bargeInSensitivity: number;
  /** "" means the system default device. */
  micDeviceId: string;
  speakerDeviceId: string;
  /** Listen for a wake phrase to hands-free start a new conversation. */
  wakeWord: boolean;
  /** The phrase that activates LILO, e.g. "hi lilo". */
  wakePhrase: string;
  /**
   * First message sent to the assistant when woken by voice. `null` follows
   * the conversation language (`DEFAULT_GREETING`); "" sends none.
   */
  wakeGreeting: string | null;
  /**
   * Persona/instruction injected as the very first message of every new
   * conversation (hidden from the transcript) so the model knows it is LILO.
   * `null` follows the conversation language (`DEFAULT_PERSONA`); "" disables
   * it.
   */
  systemPrompt: string | null;
  /**
   * Conversation language as a BCP-47 tag, or "auto" for the system language.
   *
   * It drives two things: what the upstream transcriber expects, and which
   * command phrases are matched. Leaving it on "auto"/en-US made Portuguese
   * come back truncated and half-translated, which matched no command.
   */
  language: string;
  /** Seconds of quiet before disconnecting; 0 disables the timer. */
  idleTimeoutSeconds: number;
}

export function normalizeIdleTimeout(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(3600, Math.floor(value))) : 30;
}

const STORAGE_KEY = "lilo/preferences";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The persona in each conversation language, written in that language and
 * naming no other: mentioning a language in the opening message biases the
 * model toward replying in it.
 */
export const DEFAULT_PERSONA: Record<"en" | "pt" | "it", string> = {
  en:
    "You are LILO — Listen In. Listen Out. — my realtime voice assistant. " +
    "Always call yourself LILO, never ChatGPT or Claude. Keep replies short, spoken and natural.",
  pt:
    "Você é o LILO — Listen In. Listen Out. — meu assistente de voz em tempo real. " +
    "Sempre se apresente como LILO, nunca como ChatGPT ou Claude. LILO é masculino: diga " +
    "\u201co LILO\u201d, nunca \u201ca LILO\u201d. Mantenha as respostas curtas, faladas e naturais.",
  it:
    "Sei LILO — Listen In. Listen Out. — il mio assistente vocale in tempo reale. " +
    "Presentati sempre come LILO, mai come ChatGPT o Claude. LILO è maschile: di' " +
    "\u201cil LILO\u201d, mai \u201cla LILO\u201d. Tieni le risposte brevi, parlate e naturali.",
};

export const DEFAULT_GREETING: Record<"en" | "pt" | "it", string> = {
  en: "Hi! I just activated you by voice — greet me and ask how you can help.",
  pt: "Oi! Acabei de te ativar por voz — me cumprimente e pergunte como pode ajudar.",
  it: "Ciao! Ti ho appena attivato a voce — salutami e chiedimi come puoi aiutarmi.",
};

/** The conversation-language key that selects a persona/greeting default. */
export function languageKey(language: string): "en" | "pt" | "it" {
  const locale = commandLocale(language);
  if (locale === "pt") return "pt";
  if (locale === "it") return "it";
  return "en";
}

/** The persona actually sent: the user's own, or the default for the language. */
export function effectivePersona(prefs: Pick<Preferences, "systemPrompt" | "language">): string {
  return prefs.systemPrompt ?? DEFAULT_PERSONA[languageKey(prefs.language)];
}

/** The wake greeting actually sent. */
export function effectiveGreeting(prefs: Pick<Preferences, "wakeGreeting" | "language">): string {
  return prefs.wakeGreeting ?? DEFAULT_GREETING[languageKey(prefs.language)];
}

export const DEFAULTS: Preferences = {
  theme: "system",
  accent: "indigo",
  customAccent: { from: "#6366f1", to: "#22d3ee" },
  viz: "lilo",
  animations: !prefersReducedMotion(),
  bargeIn: true,
  bargeInSensitivity: 60,
  micDeviceId: "",
  speakerDeviceId: "",
  wakeWord: true,
  wakePhrase: "lilo",
  wakeGreeting: null,
  language: "auto",
  systemPrompt: null,
  idleTimeoutSeconds: 30,
};

/** Phrases shipped before we settled on the current wake word. */
const LEGACY_WAKE_PHRASES = ["hi lilo", "hi agent", "hello lilo"];

/**
 * Content defaults that shipped earlier. A stored copy is indistinguishable
 * from something the user typed, so the only safe migration is to replace the
 * exact old strings — including the Portuguese ones an earlier build seeded
 * from the system locale, which primed Portuguese replies on an English UI.
 * They become `null`: follow the conversation language.
 */
const LEGACY_CONTENT: ReadonlyArray<{
  key: "wakeGreeting" | "systemPrompt";
  values: readonly string[];
}> = [
  {
    key: "wakeGreeting",
    values: [
      "Oi! Acabei de te ativar por voz — me cumprimente e pergunte como pode ajudar.",
      "Hi! I just activated you by voice — greet me and ask how you can help.",
    ],
  },
  {
    key: "systemPrompt",
    values: [
      "You are LILO — Listen In. Listen Out. — my realtime voice assistant. Always address yourself as LILO, never as ChatGPT. Keep replies short, spoken and natural, and answer in the language I speak.",
      "Você é o LILO — Listen In. Listen Out. — meu assistente de voz em tempo real. Sempre se apresente como LILO, nunca como ChatGPT. Mantenha as respostas curtas, faladas e naturais, e responda no idioma em que eu falo.",
      "You are LILO — Listen In. Listen Out. — my realtime voice assistant. Always address yourself as LILO, never as ChatGPT. In Portuguese, LILO is masculine: say \u201co LILO\u201d, never \u201ca LILO\u201d. Keep replies short, spoken and natural, and answer in the language I speak.",
    ],
  },
];

/**
 * Bumped when a stored value must be reinterpreted. Every save writes every
 * field, so a stored `viz` is not proof the user picked it.
 *
 * 2: the LILO character replaces the orb as the default, and "wave" is gone.
 *    "orb" was the old default, so it moves to LILO; "bars" was a real choice
 *    and stays.
 */
const PREFS_VERSION = 2;
const VERSION_KEY = "lilo/preferences-version";

function migrateViz(stored: unknown, version: number): VizMode {
  if (stored === "bars") return "bars";
  if (stored === "orb" && version >= 2) return "orb";
  return DEFAULTS.viz;
}

function load(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    if (
      parsed.wakePhrase !== undefined &&
      LEGACY_WAKE_PHRASES.includes(parsed.wakePhrase)
    ) {
      parsed.wakePhrase = DEFAULTS.wakePhrase;
    }
    for (const { key, values } of LEGACY_CONTENT) {
      if (parsed[key] !== undefined && values.includes(parsed[key] as string)) {
        parsed[key] = DEFAULTS[key];
      }
    }
    const version = Number(localStorage.getItem(VERSION_KEY)) || 1;
    parsed.viz = migrateViz(parsed.viz, version);
    // A value this build does not know (an older palette, a hand edit) must
    // not paint an undefined colour.
    if (!["system", "dark", "light"].includes(parsed.theme as string)) {
      delete parsed.theme;
    }
    if (parsed.accent !== "custom" && !(String(parsed.accent) in ACCENTS)) {
      delete parsed.accent;
    }
    parsed.idleTimeoutSeconds = normalizeIdleTimeout(parsed.idleTimeoutSeconds);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

interface PreferencesStore extends Preferences {
  setPreference: <K extends keyof Preferences>(
    key: K,
    value: Preferences[K],
  ) => void;
  reset: () => void;
}

function persist(state: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(VERSION_KEY, String(PREFS_VERSION));
  } catch {
    /* storage may be unavailable */
  }
}

export const usePreferencesStore = create<PreferencesStore>((set, get) => ({
  ...load(),

  setPreference: (key, value) => {
    const patch: Partial<Preferences> = { [key]: value };
    if (hostPort()?.features?.animations === false) patch.animations = false;
    if (key === "idleTimeoutSeconds") patch.idleTimeoutSeconds = normalizeIdleTimeout(value);
    set(patch as Pick<PreferencesStore, typeof key>);
    const s = get();
    // Commands address the assistant by the last word of the wake phrase
    // ("lilo" -> "close lilo"), so the Rust registry has to follow it.
    if (key === "wakePhrase" && isTauri()) {
      void setAssistantName(s.wakePhrase).catch(() => {});
    }
    // Only the chosen language's phrases should match; leaving every locale on
    // invites false positives from a mangled transcript.
    if (key === "language" && isTauri()) {
      void setCommandLocales([]).catch(() => {});
    }
    persist({
      theme: s.theme,
      accent: s.accent,
      customAccent: s.customAccent,
      viz: s.viz,
      animations: s.animations,
      bargeIn: s.bargeIn,
      bargeInSensitivity: s.bargeInSensitivity,
      micDeviceId: s.micDeviceId,
      speakerDeviceId: s.speakerDeviceId,
      wakeWord: s.wakeWord,
      wakePhrase: s.wakePhrase,
      wakeGreeting: s.wakeGreeting,
      systemPrompt: s.systemPrompt,
      language: s.language,
      idleTimeoutSeconds: s.idleTimeoutSeconds,
    });
  },

  reset: () => {
    set({ ...DEFAULTS });
    persist(DEFAULTS);
  },
}));

/** Apply theme / accent / animation flags to the document root. */
export function applyPreferences(
  prefs: Pick<Preferences, "theme" | "accent" | "customAccent" | "animations">,
): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(prefs.theme);
  root.dataset.animations = prefs.animations && hostPort()?.features?.animations !== false ? "on" : "off";
  const accent = accentColors(prefs);
  root.style.setProperty("--accent", accent.from);
  root.style.setProperty("--accent2", accent.to);
}
