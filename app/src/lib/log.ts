import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "./gateway";

/**
 * Ship UI-side decisions to the same `lilo.log` the Rust backend writes, so a
 * single file explains a whole session. Falls back to the console in a browser.
 */
export function log(scope: string, message: string): void {
  if (import.meta.env.DEV) {
    console.log(`[${scope}] ${message}`);
  }
  if (isTauri()) {
    void invoke("log_line", { scope, message }).catch(() => {
      /* logging must never break the app */
    });
  }
}

export function logError(scope: string, error: unknown): void {
  log(scope, `ERROR ${error instanceof Error ? error.message : String(error)}`);
}