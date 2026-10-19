import { useCallback, type PointerEvent as ReactPointerEvent } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../../lib/gateway";

/** Height of the titlebar lane (matches `.topbar`). */
export const TITLEBAR_HEIGHT = 46;

/**
 * `onPointerDown` that drags the window.
 *
 * Tauri's native `startDragging` (a real OS window drag) rather than moving by
 * pointer deltas: it handles multi-monitor, scaling and window snapping for
 * free. Interactive controls keep working because we bail out on them.
 *
 * Returns whether a drag started, so an overlay can tell a drag from a click.
 */
export function useWindowDrag(): (event: ReactPointerEvent<HTMLElement>) => boolean {
  return useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!isTauri() || event.button !== 0 || !event.isPrimary) return false;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button, a, input, select, textarea, label, [contenteditable]")) {
      return false;
    }
    event.preventDefault();
    void getCurrentWindow()
      .startDragging()
      .catch(() => {});
    return true;
  }, []);
}
