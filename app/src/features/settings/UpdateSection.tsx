import { useEffect } from "react";
import { useTranslation } from "../../i18n";
import { APP_VERSION, isTauri, openExternal } from "../../lib/gateway";
import { useSessionStore } from "../../store/sessionStore";
import { useUpdateStore, watchUpdates } from "../../store/updateStore";
import { Button, Section } from "../../shared/ui/primitives";

export function UpdateSection() {
  const { t } = useTranslation();
  const { info, check, install } = useUpdateStore();
  const connection = useSessionStore((state) => state.connectionState);
  useEffect(() => watchUpdates(), []);
  const busy = info?.status === "checking" || info?.status === "downloading" || info?.status === "installing";
  const voiceActive = connection === "connected" || connection === "connecting";
  return (
    <Section title={t("update.title")}>
      <div className="stack">
        <div className="row between"><span>{t("update.current")}</span><code>{info?.currentVersion ?? APP_VERSION}</code></div>
        {info?.version && <div className="row between"><span>{t("update.available")}</span><code>{info.version}</code></div>}
        <p className="field-help">{t("update.source")}</p>
        {info?.status === "upToDate" && <div className="notice">{t("update.upToDate")}</div>}
        {info?.status === "downloading" && <div className="notice">{info.progress === null ? t("update.downloading") : t("update.progress", { percent: info.progress })}</div>}
        {info?.status === "installing" && <div className="notice">{t("update.installing")}</div>}
        {info?.error && <div className="errorbox">{info.error}</div>}
        {info?.notes && <p className="field-help" style={{ whiteSpace: "pre-wrap" }}>{info.notes}</p>}
        {info?.version && <p className="field-help">{t(!info.installable ? "update.manualHelp" : voiceActive ? "update.endCall" : "update.restartHelp")}</p>}
        <div className="btn-stack">
          <Button disabled={!isTauri() || busy} onClick={() => void check()}>{t(info?.status === "checking" ? "update.checking" : "update.check")}</Button>
          {info?.version && (info.installable
            ? <Button variant="primary" disabled={busy || voiceActive} onClick={() => void install()}>{t("update.install")}</Button>
            : <Button onClick={() => void openExternal("https://github.com/swappcloud/lilo/releases")}>{t("update.download")}</Button>)}
        </div>
      </div>
    </Section>
  );
}
