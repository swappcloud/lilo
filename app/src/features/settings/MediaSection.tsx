import { useCallback, useEffect, useState } from "react";

import { hasHost, mediaReport } from "../../lib/gateway";
import { useTranslation } from "../../i18n";
import { useSessionStore } from "../../store/sessionStore";
import { useDraftSettings, useSettingsDraft } from "../../store/settingsDraft";
import { toast } from "../../store/toastStore";
import { RangeSlider, SelectField, Switch, TextField } from "../../shared/ui/controls";
import { Button, Section } from "../../shared/ui/primitives";
import type { MediaReport, MediaSettings } from "../../types";

export function MediaSection() {
  const { t } = useTranslation();
  const settings = useDraftSettings();
  const patchSettings = useSettingsDraft((s) => s.patchSettings);
  const runTool = useSessionStore((s) => s.runTool);
  const backendAvailable = useSessionStore((s) => s.backendAvailable);

  const [report, setReport] = useState<MediaReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const qualities = [
    { value: "high", label: t("media.qualityHigh") },
    { value: "low", label: t("media.qualityLow") },
  ];
  const resolvers = [
    { value: "auto", label: t("media.resolverAuto") },
    { value: "yt-dlp", label: t("media.resolverYtdlp") },
    { value: "http", label: t("media.resolverHttp") },
  ];

  const refresh = useCallback(() => {
    if (!hasHost()) return;
    // Swallowing this error is what made a permanently disabled button
    // indistinguishable from a broken one: with no report, `playerFound` is
    // undefined and every control greys out for no stated reason.
    mediaReport().then(setReport, (err: unknown) => {
      setReport(null);
      setError(
        t("media.statusError", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  }, [t]);

  const isPlaying = (report?.nowPlaying.queueLength ?? 0) > 0;

  // Re-check on open, and quickly while something is playing so the buttons
  // reflect reality instead of lagging several seconds behind it.
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, isPlaying ? 1000 : 4000);
    return () => clearInterval(timer);
  }, [refresh, isPlaying]);

  if (!settings) {
    return (
      <Section title={t("media.title")}>
        <div className="notice">{t("media.backendNotice")}</div>
      </Section>
    );
  }

  const media = settings.media;
  const patch = (changes: Partial<MediaSettings>) =>
    patchSettings({ media: { ...media, ...changes } });

  // `busy` is the command currently in flight. Resolving a track and starting
  // mpv takes seconds, and without this the UI looks like nothing happened.
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    setError(null);
    setBusy(name);
    try {
      await runTool(name, args);
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast(message);
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    setError(null);
    setInstalling(true);
    try {
      await runTool("media_install_deps", {});
      toast(t("media.installedToast"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setInstalling(false);
      refresh();
    }
  };

  const playing = report?.nowPlaying;
  const paused = playing?.paused ?? false;
  const missing = (report?.binaries ?? []).filter((binary) => !binary.found);
  // Split the two cases: one is a download we can do, the other genuinely
  // needs the user. Showing a single "install this" message conflates them.
  const fetchable = missing.filter((binary) => binary.canInstall);
  const manual = missing.filter((binary) => !binary.canInstall);

  return (
    <Section title={t("media.title")}>
      {!backendAvailable && (
        <div className="notice">{t("media.backendNotice")}</div>
      )}

      <div className="row between">
        <span className="muted small">{t("media.player")}</span>
        {report?.playerFound ? (
          <span className="status-chip ok">{t("media.playerReady")}</span>
        ) : (
          <span className="status-chip bad">{t("media.playerMissing")}</span>
        )}
      </div>

      <div className="row between">
        <span className="muted small">{t("media.resolverInUse")}</span>
        <span className="status-chip">{report?.resolver ?? "—"}</span>
      </div>

      {(report?.binaries ?? []).map((binary) => (
        <div className="row between" key={binary.name}>
          <span className="muted small">
            <code>{binary.name}</code>
            {binary.version ? ` ${binary.version}` : ""}
          </span>
          <span className={`status-chip${binary.found ? " ok" : " bad"}`}>
            {binary.found
              ? binary.source === "managed"
                ? t("media.installedByLilo")
                : t("media.foundOnSystem")
              : t("media.missing")}
          </span>
        </div>
      ))}

      {fetchable.length > 0 && (
        <div className="notice">
          {t("media.fetchNotice", {
            tools: fetchable.map((binary) => binary.name).join(" / "),
          })}
          <div className="btn-stack" style={{ marginTop: 10 }}>
            <Button small disabled={installing} onClick={() => void install()}>
              {installing ? t("media.downloading") : t("media.installNow")}
            </Button>
          </div>
        </div>
      )}

      {manual.length > 0 && (
        <div className="notice">
          {t("media.manualNotice", {
            tools: manual.map((binary) => binary.name).join(" / "),
          })}{" "}
          <code>{manual.map((binary) => binary.installHint).join(" && ")}</code>
        </div>
      )}

      {isPlaying && playing && (
        <div className="row between">
          <span className="muted small">
            {paused ? t("media.paused") : t("media.nowPlaying")}
          </span>
          <span className="small">
            {playing.artist ? `${playing.artist} — ` : ""}
            {playing.title || t("media.unknownTrack")}
          </span>
        </div>
      )}

      <SelectField
        label={t("media.lookup")}
        value={media.resolver}
        options={resolvers}
        onChange={(resolver) => patch({ resolver })}
        help={t("media.lookupHelp")}
      />

      {media.resolver !== "yt-dlp" && (
        <TextField
          label={t("media.service")}
          value={media.httpResolverUrl}
          onChange={(httpResolverUrl) => patch({ httpResolverUrl })}
          placeholder="https://pipedapi.kavin.rocks"
          help={t("media.serviceHelp")}
        />
      )}

      <SelectField
        label={t("media.quality")}
        value={media.audioQuality}
        options={qualities}
        onChange={(audioQuality) => patch({ audioQuality })}
        help={t("media.qualityHelp")}
      />

      <div className="row between">
        <span style={{ fontSize: 13, fontWeight: 600 }}>{t("media.autoplay")}</span>
        <Switch
          checked={media.autoplayRelated}
          onChange={(autoplayRelated) => patch({ autoplayRelated })}
          label={t("media.autoplay")}
        />
      </div>
      <p className="field-help">{t("media.autoplayHelp")}</p>

      <RangeSlider
            label={t("media.volumeLabel")}
            value={media.volume}
            unit="%"
        onChange={(volume) => patch({ volume })}
      />

      <RangeSlider
            label={t("media.duckVolumeLabel")}
        min={10}
            value={media.duckPercent}
            unit="%"
        onChange={(duckPercent) => patch({ duckPercent })}
      />

      <TextField
        label={t("media.mpvPath")}
        value={media.mpvPath}
        onChange={(mpvPath) => patch({ mpvPath })}
        placeholder={t("media.autoDetected")}
        help={t("media.mpvPathHelp")}
      />

      <TextField
        label={t("media.ytdlpPath")}
        value={media.ytDlpPath}
        onChange={(ytDlpPath) => patch({ ytDlpPath })}
        placeholder={t("media.autoDetected")}
      />

      <div className="btn-stack">
        <Button
          small
          disabled={!report?.playerFound || busy !== null || isPlaying}
          onClick={() =>
            void run("media_play", { track: "the beatles here comes the sun" })
          }
        >
          {busy === "media_play" ? t("media.starting") : t("media.testPlayback")}
        </Button>
        <Button
          small
          disabled={!isPlaying || busy !== null}
          onClick={() => void run(paused ? "media_resume" : "media_pause")}
        >
          {paused ? t("media.resume") : t("media.pause")}
        </Button>
        <Button
          small
          disabled={!isPlaying || busy !== null}
          onClick={() => void run("media_stop")}
        >
          {busy === "media_stop" ? t("media.stopping") : t("media.stop")}
        </Button>
      </div>

      {/* A disabled button with no reason reads as a broken button. */}
      {!report?.playerFound ? (
        <p className="field-help">
          {t("media.needsPlayer")}{" "}
          {report?.canInstall
            ? t("media.playerDownloading")
            : t("media.playerInstallHint")}
        </p>
      ) : !isPlaying ? (
        <p className="field-help">{t("media.nothingPlaying")}</p>
      ) : null}

      {error && <div className="errorbox">{error}</div>}
    </Section>
  );
}
