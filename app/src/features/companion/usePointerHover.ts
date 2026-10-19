import { useEffect } from "react";

import { listen } from "@tauri-apps/api/event";

import { isTauri } from "../../lib/gateway";

const POINTER_EVENT = "lilo://companion-pointer";

/**
 * Hover for a window that is rarely focused. macOS sends no mouse moves to an
 * unfocused window, so `:hover` never fires on the companion; Rust reports the
 * cursor over the live parts instead, and the button under it gets
 * `data-hover` for the stylesheet.
 */
export function usePointerHover(): void {
  useEffect(() => {
    if (!isTauri()) return;
    let hovered: Element | null = null;
    const set = (next: Element | null) => {
      if (next === hovered) return;
      hovered?.removeAttribute("data-hover");
      next?.setAttribute("data-hover", "");
      hovered = next;
    };
    const pending = listen<{ x: number; y: number } | null>(POINTER_EVENT, (event) => {
      const at = event.payload;
      set(at ? (document.elementFromPoint(at.x, at.y)?.closest("button") ?? null) : null);
    });
    return () => {
      set(null);
      void pending.then((unlisten) => unlisten());
    };
  }, []);
}
