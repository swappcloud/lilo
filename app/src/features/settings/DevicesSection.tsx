import { useMediaDevices } from "../../shared/hooks/useMediaDevices";
import { useDraftPreference, useSettingsDraft } from "../../store/settingsDraft";
import { useSessionStore } from "../../store/sessionStore";
import { toast } from "../../store/toastStore";
import { useTranslation } from "../../i18n";
import { SelectField } from "../../shared/ui/controls";
import { Button, Section } from "../../shared/ui/primitives";

export function DevicesSection() {
  const { t } = useTranslation();
  const {
    inputs,
    outputs,
    requestAccess,
    needsPermission,
    supportsOutputSelection,
  } = useMediaDevices();

  const micDeviceId = useDraftPreference("micDeviceId");
  const speakerDeviceId = useDraftPreference("speakerDeviceId");
  const setPreference = useSettingsDraft((s) => s.setPreference);

  const connectionState = useSessionStore((s) => s.connectionState);

  const live = connectionState === "connected";
  const platform = useSessionStore((s) => s.env?.platform) ?? document.documentElement.dataset.os;

  const onMicChange = (value: string) => setPreference("micDeviceId", value);

  const onSpeakerChange = (value: string) => setPreference("speakerDeviceId", value);

  return (
    <Section title={t("devices.title")}>
      <div className="stack">
        {needsPermission && (
          <div className="notice">
            {t(platform === "macos" ? "devices.permissionNotice" : "devices.permissionNoticeGeneral")}
            <div className="btn-stack" style={{ marginTop: 10 }}>
              <Button
                small
                onClick={() => {
                    void requestAccess().then(() => toast(t("devices.refreshed")), () => toast(t("devices.permissionFailed")));
                }}
              >
                {t("devices.allowMic")}
              </Button>
            </div>
          </div>
        )}

        <SelectField
          label={t("devices.microphone")}
          value={micDeviceId}
          options={[
            { value: "", label: t("devices.systemDefault") },
            ...inputs.map((device) => ({ value: device.deviceId, label: device.label })),
          ]}
          onChange={onMicChange}
          help={live ? t("devices.appliedLive") : t("devices.nextSession")}
        />

        <SelectField
          label={t("devices.output")}
          value={speakerDeviceId}
          disabled={!supportsOutputSelection}
          options={[
            { value: "", label: t("devices.systemDefault") },
            ...outputs.map((device) => ({ value: device.deviceId, label: device.label })),
          ]}
          onChange={onSpeakerChange}
          help={
            supportsOutputSelection
              ? t("devices.outputHelp")
              : t("devices.outputUnsupported")
          }
        />

        <div className="row between">
          <span className="muted small">
            {t("devices.counts", { inputs: inputs.length, outputs: outputs.length })}
          </span>
          <Button
            small
            onClick={() => {
              // Re-asking is harmless once granted, and it is what makes a
              // freshly plugged device show up on demand.
              void requestAccess().catch(() => toast(t("devices.permissionFailed")));
            }}
          >
            {t("devices.refresh")}
          </Button>
        </div>

        <p className="field-help">{t("devices.footer")}</p>
      </div>
    </Section>
  );
}
