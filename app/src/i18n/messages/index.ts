/**
 * Every domain's messages, merged into one dictionary per language.
 *
 * The domains stay separate files so each one is small and owned by the area
 * it describes; this module is the only place that knows about all of them.
 *
 * The spreads are written out rather than mapped over an array: a mapped
 * `Object.assign` collapses to `{}` and turns `TranslationKey` into
 * `string | number | symbol`, which would silently disable every type check
 * this dictionary exists to give.
 */

import { conversation } from "./conversation";
import { commands } from "./commands";
import { diagnostics } from "./diagnostics";
import { daemon } from "./daemon";
import { companion } from "./companion";
import { common } from "./common";
import { media } from "./media";
import { player } from "./player";
import { plugins } from "./plugins";
import { process } from "./process";
import { session } from "./session";
import { settings } from "./settings";
import { settingsAudio } from "./settingsAudio";
import { shell } from "./shell";
import { updates } from "./updates";
import type { BuiltinUILocale } from "../types";

/** English is the source of truth for the key set. */
export const EN = {
  ...daemon.en,
  ...conversation.en,
  ...diagnostics.en,
  ...updates.en,
  ...shell.en,
  ...companion.en,
  ...player.en,
  ...plugins.en,
  ...settings.en,
  ...settingsAudio.en,
  ...media.en,
  ...process.en,
  ...commands.en,
  ...session.en,
  ...common.en,
};

export type TranslationKey = keyof typeof EN;

/** Portuguese is checked against the English keys by construction. */
export const PT: Record<TranslationKey, string> = {
  ...daemon.pt,
  ...conversation.pt,
  ...diagnostics.pt,
  ...updates.pt,
  ...shell.pt,
  ...companion.pt,
  ...player.pt,
  ...plugins.pt,
  ...settings.pt,
  ...settingsAudio.pt,
  ...media.pt,
  ...process.pt,
  ...commands.pt,
  ...session.pt,
  ...common.pt,
};

/** Italian is checked against the English keys by construction. */
export const IT: Record<TranslationKey, string> = {
  ...daemon.it,
  ...conversation.it,
  ...diagnostics.it,
  ...updates.it,
  ...shell.it,
  ...companion.it,
  ...player.it,
  ...plugins.it,
  ...settings.it,
  ...settingsAudio.it,
  ...media.it,
  ...process.it,
  ...commands.it,
  ...session.it,
  ...common.it,
};

export const DICTIONARIES: Record<BuiltinUILocale, Record<TranslationKey, string>> = {
  en: EN,
  pt: PT,
  it: IT,
};
