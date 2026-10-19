import { useTranslation } from "../../i18n";
import { useDraftPreference, useSettingsDraft } from "../../store/settingsDraft";
import { LANGUAGES, resolveLanguage } from "../../store/language";
import { SelectField } from "../../shared/ui/controls";
import { Section } from "../../shared/ui/primitives";
import { usePluginLanguages } from "../../i18n/pluginLanguages";

/**
 * The interface and conversation language. Command recognition accepts all
 * declared languages independently of this preference.
 *
 * The command reference is its own panel (H in the topbar): it is something
 * you consult mid-conversation, not something you configure once.
 */
export function CommandsSection() {
  const languages = usePluginLanguages((s) => s.entries);
  const { t } = useTranslation();
  const language = useDraftPreference("language");
  const setPreference = useSettingsDraft((s) => s.setPreference);

  return (
    <Section title={t("language.title")}>
      <SelectField
        label={t("language.label")}
        value={language}
        options={[...LANGUAGES.map((option) => ({
          value: option.value,
          label: t(option.labelKey),
        })), ...languages.map((pack) => ({ value: pack.tag, label: pack.name }))]}
        onChange={(next) => setPreference("language", next)}
        help={t("language.help", { language: resolveLanguage(language) })}
      />
    </Section>
  );
}
