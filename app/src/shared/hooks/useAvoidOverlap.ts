import { useEffect, type RefObject } from "react";

function intersects(a: DOMRect, b: DOMRect, margin: number): boolean {
  return (
    a.left < b.right + margin &&
    a.right + margin > b.left &&
    a.top < b.bottom + margin &&
    a.bottom + margin > b.top
  );
}

/**
 * Hide `ref` whenever it would touch the element matching `obstacle`.
 *
 * CSS alone cannot promise this: the obstacle (the dock) changes width with
 * what it holds — the player row, a long track title — and the hint wraps
 * with the window. So measure, on every size change of either, and on window
 * resize. The hidden element keeps its layout box (`visibility`), so the
 * measurement stays valid while it is hidden.
 */
export function useAvoidOverlap(
  ref: RefObject<HTMLElement | null>,
  obstacle: string,
  margin = 16,
): void {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const check = () => {
      const other = document.querySelector(obstacle);
      const clash =
        !!other && intersects(node.getBoundingClientRect(), other.getBoundingClientRect(), margin);
      node.style.visibility = clash ? "hidden" : "";
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(node);
    const other = document.querySelector(obstacle);
    if (other) observer.observe(other);
    // The dock can be replaced (player appears): watch its parent for that.
    const mutations = new MutationObserver(() => {
      const next = document.querySelector(obstacle);
      if (next) observer.observe(next);
      check();
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", check);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", check);
    };
  }, [ref, obstacle, margin]);
}
