import { useEffect } from "react";

import { applyPreferences, usePreferencesStore } from "../store/preferencesStore";

/** Keep the document's theme, palette and animation flags on the preferences. */
export function useApplyPreferences(): void {
  const theme = usePreferencesStore((s) => s.theme);
  const accent = usePreferencesStore((s) => s.accent);
  const customAccent = usePreferencesStore((s) => s.customAccent);
  const animations = usePreferencesStore((s) => s.animations);

  useEffect(() => {
    applyPreferences({ theme, accent, customAccent, animations });
  }, [theme, accent, customAccent, animations]);

  // "System" follows the OS live: switching macOS or Windows to dark mode
  // repaints without a restart.
  useEffect(() => {
    if (theme !== "system" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyPreferences(usePreferencesStore.getState());
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [theme]);
}
