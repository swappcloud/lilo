/**
 * Which window this page is, and the calls only the owner may run.
 *
 * The main window is the owner: the voice session, the microphone, the wake
 * word and every store's persistence live there. In companion mode settings
 * and history open in a second window, the panel (see `src-tauri/src/shell.rs`),
 * which is only a view: it shows a mirror of the owner's stores and sends
 * every action back (`windowBridge.ts`). This module imports no store, so any
 * of them can ask where it runs without an import cycle.
 */

export type PanelName = "settings" | "conversations" | "transcript" | "commands";

export const PANEL_NAMES: readonly PanelName[] = [
  "settings",
  "conversations",
  "transcript",
  "commands",
];

export interface PanelLaunch {
  panel: PanelName;
  /** The system's material is behind the page, so the page stays see-through. */
  material: boolean;
}

declare global {
  interface Window {
    /** Set by Rust before the first script runs, only in the panel window. */
    __LILO_PANEL__?: { panel?: string; material?: boolean };
  }
}

export function isPanelName(value: unknown): value is PanelName {
  return PANEL_NAMES.includes(value as PanelName);
}

/** What the panel window was opened for, or null in the main window. */
export function panelLaunch(): PanelLaunch | null {
  const launch = typeof window === "undefined" ? undefined : window.__LILO_PANEL__;
  if (!launch) return null;
  return {
    panel: isPanelName(launch.panel) ? launch.panel : "settings",
    material: launch.material === true,
  };
}

export function isOwnerWindow(): boolean {
  return panelLaunch() === null;
}

type Handler = (...args: never[]) => unknown;
type Remote = (name: string, args: unknown[]) => Promise<unknown>;

const handlers = new Map<string, Handler>();
let remote: Remote | null = null;

/**
 * A function with effects that belong to the owner (the session, the scene,
 * the microphone). In the owner it runs in place; in the panel it runs in the
 * owner and resolves with its result. Arguments and result cross as JSON.
 */
export function ownerCall<A extends unknown[], R>(
  name: string,
  run: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<R> {
  handlers.set(name, run as Handler);
  return async (...args: A) => {
    if (isOwnerWindow()) return run(...args);
    if (!remote) throw new Error(`owner call ${name} before the bridge is up`);
    return (await remote(name, args)) as R;
  };
}

/** The owner side: run a call the panel asked for. */
export function runOwnerCall(name: string, args: unknown[]): unknown {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`unknown owner call ${name}`);
  return (handler as (...values: unknown[]) => unknown)(...args);
}

/** The panel side: how calls reach the owner. */
export function setOwnerRemote(next: Remote | null): void {
  remote = next;
}
