import { useSessionStore } from "../../store/sessionStore";
import { useDraftSettings, useSettingsDraft } from "../../store/settingsDraft";
import { useTranslation } from "../../i18n";
import { TextField, Switch } from "../../shared/ui/controls";
import { Section } from "../../shared/ui/primitives";
import type { AppSettings } from "../../types";

export function GatewaySection() {
  const { t } = useTranslation();
  const draft = useDraftSettings();
  const patchSettings = useSettingsDraft((s) => s.patchSettings);
  const backendAvailable = useSessionStore((s) => s.backendAvailable);

  if (!draft) {
    return (
      <Section title={t("gateway.title")}>
        <p className="field-help">
          {backendAvailable ? t("gateway.loading") : t("gateway.desktopOnly")}
        </p>
      </Section>
    );
  }

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    patchSettings({ [key]: value } as Partial<AppSettings>);

  return (
    <Section title={t("gateway.title")}>
      <div className="stack">
        <div className="row between">
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {t("gateway.external")}
          </span>
          <Switch
            checked={draft.useExternalGateway}
            onChange={(next) => update("useExternalGateway", next)}
            label={t("gateway.external")}
          />
        </div>
        <p className="field-help">{t("gateway.externalHelp")}</p>

        <TextField
          label={t("gateway.url")}
          value={draft.externalGatewayUrl}
          onChange={(value) => update("externalGatewayUrl", value)}
          placeholder="http://127.0.0.1:8000"
        />
        <TextField
          label={t("gateway.authKey")}
          type="password"
          value={draft.gatewayAuthKey}
          onChange={(value) => update("gatewayAuthKey", value)}
        />

        <details className="disclosure">
          <summary>{t("gateway.identity")}</summary>
          <div className="stack">
            <TextField
              label="oai-client-version"
              value={draft.clientVersion}
              onChange={(value) => update("clientVersion", value)}
            />
            <TextField
              label="oai-client-build-number"
              value={draft.clientBuildNumber}
              onChange={(value) => update("clientBuildNumber", value)}
            />
            <TextField
              label="User-Agent"
              value={draft.userAgent}
              onChange={(value) => update("userAgent", value)}
              multiline
              rows={2}
            />
          </div>
        </details>
      </div>
    </Section>
  );
}