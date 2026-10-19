import { CardHeader } from "../../shared/ui/CardHeader";
import { StatusBadge, type StatusTone } from "../../shared/ui/StatusBadge";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { isTauri, storageClear, storageReport } from "../../lib/gateway";
import { useTranslation, type TranslationKey } from "../../i18n";
import { toast } from "../../store/toastStore";
import { formatBytes } from "../../shared/lib/format";
import { Button, Section } from "../../shared/ui/primitives";
import type {
  PluginUsage,
  StorageArea,
  StorageReport,
  UsageEntry,
  UsageKind,
} from "../../types";

const LABELS: Record<StorageArea, TranslationKey> = {
  media: "storage.media",
  logs: "storage.logs",
  cache: "storage.cache",
};

const CLEAR_LABELS: Record<StorageArea, TranslationKey> = {
  media: "storage.clearAll",
  logs: "storage.clearLogs",
  cache: "storage.clearCache",
};

const CLEARED: Record<StorageArea, TranslationKey> = {
  media: "storage.componentsRemoved",
  logs: "storage.logsCleared",
  cache: "storage.cacheCleared",
};

const USAGE_LABELS: Record<UsageKind, TranslationKey> = {
  plugins: "storage.plugins",
  webviews: "storage.webviews",
};

/** How often the panel refreshes while it is open: plugins come and go. */
const POLL_MS = 15000;

/** One usage row: what it is, how much, and its share of the total. */
function UsageRow({
  label,
  bytes,
  total,
  detail,
  children,
}: {
  label: string;
  bytes: number;
  total: number;
  detail?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const share = total > 0 ? Math.min(100, (bytes / total) * 100) : 0;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row between">
        <span className="muted small">
          {label}
          {detail ? ` · ${detail}` : ""}
        </span>
        <span className="row" style={{ gap: 10 }}>
          <span className="small">{formatBytes(bytes, t)}</span>
          {children}
        </span>
      </div>
      <div className="bar">
        <i style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}

/**
 * Disk usage, per plugin.
 *
 * The removable areas differ in cost: cache is always disposable, logs are
 * just history, and the media binaries come back as a download — so only that
 * one asks for confirmation. Plugins and webview profiles are shown for
 * accounting but are cleared where they belong (uninstall, sign out).
 * Memory/CPU/threads are their own page: Process.
 */
export function StorageSection() {
  const { t } = useTranslation();
  const [report, setReport] = useState<StorageReport | null>(null);
  const [busy, setBusy] = useState<StorageArea | null>(null);
  /** Area asking to be cleared. Inline, because the webview has no real
   *  `window.confirm` — a native dialog would silently swallow the click. */
  const [confirming, setConfirming] = useState<StorageArea | null>(null);

  const refresh = useCallback(() => {
    if (!isTauri()) return;
    storageReport().then(setReport, () => setReport(null));
  }, []);

  useEffect(() => {
    refresh();
    // Disk usage changes when plugins are installed; a slow poll keeps the
    // page honest without reading the disk on every render.
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!isTauri()) {
    return (
      <Section title={t("storage.title")}>
        <div className="notice">{t("storage.backendNotice")}</div>
      </Section>
    );
  }

  const clear = async (area: StorageArea) => {
    setConfirming(null);
    setBusy(area);
    try {
      const freed = await storageClear(area);
      toast(t(CLEARED[area], { freed: formatBytes(freed, t) }));
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const total = report?.totalBytes ?? 0;
  const pluginBytes = report?.usage.find((entry) => entry.kind === "plugins")?.bytes ?? 0;

  const pluginState = (plugin: PluginUsage): { label: string; tone: StatusTone } => {
    if (!plugin.enabled) return { label: t("storage.pluginInactive"), tone: "neutral" };
    if (!plugin.loaded) return { label: t("storage.pluginNotLoaded"), tone: "warning" };
    return { label: t("storage.pluginActive"), tone: "positive" };
  };

  return (
    <Section title={t("storage.title")}>
      <div className="row between">
        <span className="muted small">{t("storage.used")}</span>
        <span className="status-chip">{report ? formatBytes(total, t) : "—"}</span>
      </div>

      {(report?.usage ?? []).map((entry: UsageEntry) => (
        <UsageRow
          key={entry.kind}
          label={t(USAGE_LABELS[entry.kind])}
          detail={t("storage.files", { count: entry.files })}
          bytes={entry.bytes}
          total={total}
        />
      ))}

      {(report?.areas ?? []).map((usage) =>
        confirming === usage.area ? (
          <div className="row between" key={usage.area} style={{ marginTop: 10 }}>
            <span className="muted small">{t("storage.confirmRemove")}</span>
            <span className="row">
              <button className="btn small ghost" onClick={() => setConfirming(null)}>
                {t("common.cancel")}
              </button>
              <button className="btn small danger" onClick={() => void clear(usage.area)}>
                {t(CLEAR_LABELS[usage.area])}
              </button>
            </span>
          </div>
        ) : (
          <UsageRow
            key={usage.area}
            label={t(LABELS[usage.area])}
            bytes={usage.bytes}
            total={total}
          >
            <Button
              small
              disabled={busy !== null || !usage.clearable || usage.bytes === 0}
              // Only the media binaries cost something to bring back.
              onClick={() =>
                usage.area === "media" ? setConfirming(usage.area) : void clear(usage.area)
              }
            >
              {busy === usage.area ? t("storage.clearing") : t(CLEAR_LABELS[usage.area])}
            </Button>
          </UsageRow>
        ),
      )}

      {(report?.plugins ?? []).length > 0 && (
        <div className="set-group" style={{ marginTop: 16 }}>
          <div className="sec">
            {t("storage.plugins")}
            {" · "}
            {formatBytes(pluginBytes, t)}
          </div>
          <div className="set-card">
            {(report?.plugins ?? []).map((plugin) => {
              const state = pluginState(plugin);
              const runtime =
                plugin.runtime === "quickjs"
                  ? t("storage.runtimeQuickjs")
                  : plugin.runtime === "process"
                    ? t("storage.runtimeProcess")
                    : "";
              const details = [
                plugin.version ? `v${plugin.version}` : "",
                runtime,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <div className="storage-plugin-entry" key={plugin.id}>
                  <CardHeader title={plugin.name} description={[details, formatBytes(plugin.bytes, t)].filter(Boolean).join(" · ")}
                    status={<StatusBadge tone={state.tone}>{state.label}</StatusBadge>} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="btn-stack">
        <Button small onClick={refresh} disabled={busy !== null}>
          {t("storage.refresh")}
        </Button>
      </div>
    </Section>
  );
}
