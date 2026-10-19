import { useEffect } from "react";

import { call, isTauri } from "../../lib/gateway";

const EVERY_MS = 200;

/**
 * Tell Rust which parts of the companion take the mouse (`[data-hit]`
 * elements); everywhere else, clicks fall through to the desktop underneath.
 * Sent only when the layout changed.
 */
export function useHitRegions(): void {
  useEffect(() => {
    if (!isTauri()) return;
    let sent = "";
    const report = () => {
      const rects = Array.from(document.querySelectorAll<HTMLElement>("[data-hit]"))
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => ({
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        }));
      const key = JSON.stringify(rects);
      if (key === sent) return;
      sent = key;
      void call<void>("shell_hit_regions", { rects }).catch(() => {
        sent = "";
      });
    };
    report();
    const timer = window.setInterval(report, EVERY_MS);
    return () => {
      window.clearInterval(timer);
      void call<void>("shell_hit_regions", { rects: [] }).catch(() => {});
    };
  }, []);
}
