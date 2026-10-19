import { create } from "zustand";

import { translate } from "../i18n";

/**
 * Why the wake listener cannot work right now.
 *
 * Reasons are OS-independent keys: each platform's engine reports its own
 * failure, and the UI maps the key to a message and, when there is one, a
 * concrete action. The wake contract stays the same everywhere.
 */
export type WakeBlockReason =
  | "dictation-disabled"
  | "not-allowed"
  | "service-not-allowed"
  | "network"
  | "language-not-supported"
  | "no-recognizer"
  | "unsupported"
  | "recognizer-error";

export interface WakeBlock {
  reason: WakeBlockReason | string;
  detail?: string;
}

interface WakeStore {
  blocked: WakeBlock | null;
  setBlocked: (blocked: WakeBlock | null) => void;
}

export const useWakeStore = create<WakeStore>((set) => ({
  blocked: null,
  setBlocked: (blocked) => set({ blocked }),
}));

export interface WakeBlockCopy {
  title: string;
  body: string;
  /** Deep link that takes the user straight to the setting, when one exists. */
  action?: { label: string; url: string };
}

/**
 * Human-facing copy for a block reason, in the current interface language.
 *
 * The section re-renders when the language changes, so the non-reactive lookup
 * below stays correct without its own subscription.
 */
export function describeWakeBlock(block: WakeBlock): WakeBlockCopy {
  switch (block.reason) {
    case "dictation-disabled":
      return {
        title: translate("wake.blockDictationTitle"),
        body: translate("wake.blockDictationBody"),
        action: {
          label: translate("wake.blockDictationAction"),
          url: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
        },
      };
    case "not-allowed":
    case "service-not-allowed":
      return {
        title: translate("wake.blockDeniedTitle"),
        body: translate("wake.blockDeniedBody"),
      };
    case "no-recognizer":
    case "unsupported":
      return {
        title: translate("wake.blockNoEngineTitle"),
        body: translate("wake.blockNoEngineBody"),
      };
    default:
      return {
        title: translate("wake.blockFailedTitle"),
        body: block.detail?.trim() || translate("wake.blockFailedBody"),
      };
  }
}