import { useEffect, useState } from "react";

/**
 * Keep a value on screen for `exitMs` after it goes away, so it can fade out
 * instead of vanishing. Returns what to render and whether it is leaving.
 */
export function usePresence<T>(value: T | null, exitMs: number): { shown: T | null; leaving: boolean } {
  const [shown, setShown] = useState<T | null>(value);

  useEffect(() => {
    if (value !== null) {
      setShown(value);
      return;
    }
    const timer = window.setTimeout(() => setShown(null), exitMs);
    return () => window.clearTimeout(timer);
  }, [value, exitMs]);

  return { shown: value ?? shown, leaving: value === null && shown !== null };
}
