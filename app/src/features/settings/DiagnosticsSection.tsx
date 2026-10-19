import { useState } from "react";
import { useTranslation } from "../../i18n";
import { isTauri } from "../../lib/gateway";
import { Button, Section } from "../../shared/ui/primitives";
import { downloadDiagnosticLogs } from "./diagnostics";

export function DiagnosticsSection() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <Section title={t("diagnostics.title")}>
      <p className="muted small">{t("diagnostics.help")}</p>
      <div className="notice">{t("diagnostics.privacy")}</div>
      {isTauri() ? (
        <div className="btn-stack">
          <Button disabled={busy} onClick={() => {
            setBusy(true);
            void downloadDiagnosticLogs().finally(() => setBusy(false));
          }}>{t(busy ? "diagnostics.saving" : "diagnostics.download")}</Button>
        </div>
      ) : <div className="notice">{t("diagnostics.desktopOnly")}</div>}
    </Section>
  );
}
