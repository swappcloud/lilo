import { useEffect, useMemo } from "react";

import { useTranslation, type TranslationKey } from "../i18n";
import { call, isTauri } from "../lib/gateway";
import { isPlaying, useMediaStore } from "../store/mediaStore";
import { usePreferencesStore } from "../store/preferencesStore";
import { selectVoiceBudget, useSessionStore } from "../store/sessionStore";

/** Menu label keys Rust asks for, and where each lives in the dictionary. */
const MENU_LABELS = [
  "conversation",
  "voice",
  "media",
  "window",
  "help",
  "start",
  "end",
  "interrupt",
  "mute",
  "play",
  "pause",
  "next",
  "previous",
  "stop",
  "settings",
  "downloadLogs",
  "conversations",
  "transcript",
  "commands",
  "show",
  "hide",
  "recenter",
  "quit",
  "companion",
  "statusIdle",
  "statusConnecting",
  "statusLive",
  "statusMuted",
] as const;

/**
 * Keep the native menus (macOS menu bar, tray, the mascot's context menu) in
 * step with the session and in the UI language. Rust only rebuilds what
 * changed, so pushing on every relevant change is cheap.
 */
export function useShellState(): void {
  const { t } = useTranslation();
  const connectionState = useSessionStore((s) => s.connectionState);
  const muted = useSessionStore((s) => s.muted);
  const speaking = useSessionStore((s) => s.assistantSpeaking);
  const budgetSeconds = useSessionStore(selectVoiceBudget);
  const nowPlaying = useMediaStore((s) => s.nowPlaying);
  const theme = usePreferencesStore((s) => s.theme);

  // The window's own appearance (title bar, material) follows the app theme.
  useEffect(() => {
    if (!isTauri()) return;
    void call<void>("shell_theme", { theme: theme === "system" ? null : theme }).catch(() => {});
  }, [theme]);

  const labels = useMemo(
    () =>
      Object.fromEntries(
        MENU_LABELS.map((key) => [key, t(`menu.${key}` as TranslationKey)]),
      ),
    [t],
  );

  const live = connectionState === "connected";
  const busy = connectionState === "connecting" || connectionState === "reconnecting";
  const playing = isPlaying(nowPlaying);
  const paused = nowPlaying?.paused ?? false;
  const budget =
    budgetSeconds === null
      ? null
      : t("shell.budgetChip", { minutes: Math.max(0, Math.round(budgetSeconds / 60)) });

  useEffect(() => {
    if (!isTauri()) return;
    void call<void>("shell_state", {
      flags: {
        live,
        busy,
        muted,
        speaking: live && speaking,
        playing,
        paused,
        budget,
        labels,
      },
    }).catch(() => {});
  }, [live, busy, muted, speaking, playing, paused, budget, labels]);
}
