import { useTranslation } from "../../i18n";
import { Section } from "../../shared/ui/primitives";
import { useDraftPreference, useSettingsDraft } from "../../store/settingsDraft";

export function ConversationSection() {
  const { t } = useTranslation();
  const seconds = useDraftPreference("idleTimeoutSeconds");
  const setPreference = useSettingsDraft((state) => state.setPreference);
  return (
    <Section title={t("conversation.title")}>
      <label>
        <span className="field-label">{t("conversation.idleSeconds")}</span>
        <input className="field" type="number" min={0} max={3600} step={1} value={seconds}
          onChange={(event) => setPreference("idleTimeoutSeconds", Math.max(0, Math.min(3600, Math.floor(Number(event.target.value)))))} />
        <span className="field-help">{t("conversation.idleHelp")}</span>
      </label>
    </Section>
  );
}
