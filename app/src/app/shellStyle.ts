/**
 * Which shell the window wears: the classic app window, or the desktop
 * companion (a transparent window with only LILO in it).
 *
 * Rust owns the choice — it has to build the window transparent from birth —
 * and tells the page before its first script runs (`window.__LILO_SHELL__`).
 * Switching later arrives as `lilo://shell-style`; the page swaps shells in
 * place, so a live voice session survives the switch.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import { call, isTauri } from "../lib/gateway";

export type ShellStyle = "classic" | "companion";

const STYLE_EVENT = "lilo://shell-style";

declare global {
  interface Window {
    __LILO_SHELL__?: string;
  }
}

function initialStyle(): ShellStyle {
  return typeof window !== "undefined" && window.__LILO_SHELL__ === "companion"
    ? "companion"
    : "classic";
}

function mark(style: ShellStyle): void {
  document.documentElement.dataset.shell = style;
}

interface ShellStyleStore {
  style: ShellStyle;
  /** Ask Rust to switch; the style event does the rest. */
  setCompanion: (enabled: boolean) => Promise<void>;
}

export const useShellStyle = create<ShellStyleStore>(() => ({
  style: initialStyle(),
  setCompanion: async (enabled) => {
    if (!isTauri()) return;
    await call<void>("shell_set_companion", { enabled });
  },
}));

/** Mark the document before first paint and follow later switches. */
export function watchShellStyle(): Promise<UnlistenFn> | null {
  mark(useShellStyle.getState().style);
  if (!isTauri()) return null;
  return listen<string>(STYLE_EVENT, (event) => {
    const style: ShellStyle = event.payload === "companion" ? "companion" : "classic";
    mark(style);
    useShellStyle.setState({ style });
  });
}
