import type { Translate } from "../../i18n";

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`;
}

export function relativeTime(timestamp: number, t: Translate): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return t("time.now");
  if (minutes < 60) return t("time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("time.hours", { count: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return t("time.days", { count: days });
  return new Date(timestamp).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

const UNITS: ReadonlyArray<{ limit: number; key: "unit.gb" | "unit.mb" | "unit.kb" }> = [
  { limit: 1024 ** 3, key: "unit.gb" },
  { limit: 1024 ** 2, key: "unit.mb" },
  { limit: 1024, key: "unit.kb" },
];

/** Human-readable size, localized (the units themselves are near-universal). */
export function formatBytes(bytes: number, t: Translate): string {
  if (bytes < 1024) return `${bytes} ${t("unit.bytes")}`;
  for (const unit of UNITS) {
    if (bytes >= unit.limit) {
      const value = bytes / unit.limit;
      return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${t(unit.key)}`;
    }
  }
  return `${bytes} ${t("unit.bytes")}`;
}