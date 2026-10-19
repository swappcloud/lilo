import { retainPluginSelection } from "../../providers/plugins/registry";
import { usePluginsStore } from "../../store/pluginsStore";
import { ProviderLimitNotice } from "../voice/ProviderLimitNotice";
import { useEffect, useMemo } from "react";

import {
  providerMeta,
  providerMetas,
  type ProviderSettingField,
  type ProviderSettingOption,
} from "../../providers";
import { resolveLanguage } from "../../store/language";
import { selectActiveConversation, useSessionStore } from "../../store/sessionStore";
import {
  useDraftPreference,
  useDraftProviderId,
  useDraftProviderOptions,
  useSettingsDraft,
} from "../../store/settingsDraft";
import { toast } from "../../store/toastStore";
import { useTranslation } from "../../i18n";
import { Section } from "../../shared/ui/primitives";
import { SelectField, TextField } from "../../shared/ui/controls";
import { ProviderStatusBadge } from "./ProviderStatusBadge";

export function ProviderSection() {
  const { t } = useTranslation();
  const committedProviderId = useSessionStore((s) => s.providerId);
  const setCommittedProviderId = useSessionStore((s) => s.setProviderId);
  const providerId = useDraftProviderId();
  const setProviderId = useSettingsDraft((s) => s.setProviderId);
  const providerOptions = useDraftProviderOptions();
  const setProviderOption = useSettingsDraft((s) => s.setProviderOption);
  const sessions = useSessionStore(selectActiveConversation)?.sessions;
  const connectionState = useSessionStore((s) => s.connectionState);
  const accounts = useSessionStore((s) => s.accounts);
  const plugins = usePluginsStore((s) => s.plugins);
  const language = resolveLanguage(useDraftPreference("language"));

  // A backend that needs an account stays hidden from the list until a healthy
  // account *of that backend* is present; `selectable` hides backends still
  // being built. The same address can be signed in to both, so match on the
  // provider too.
  const available = useMemo(
    () =>
      retainPluginSelection(providerMetas().filter(
        (m) =>
          m.selectable &&
          (!m.requiresAccount ||
            accounts.some((a) => a.status === "ok" && a.provider === (m.accountProviderId ?? m.id))),
      ), providerId),
    [accounts, plugins, providerId],
  );
  const effectiveId = available.some((m) => m.id === providerId)
    ? providerId
    : available[0]?.id;

  // Fall back (and persist) when the selected backend becomes unavailable,
  // e.g. signed out while ChatGPT was selected.
  const committedAvailable = available.some((m) => m.id === committedProviderId);
  useEffect(() => {
    if (effectiveId && !committedAvailable && effectiveId !== committedProviderId) {
      setCommittedProviderId(effectiveId);
      toast(t("provider.switched"));
    }
  }, [effectiveId, committedAvailable, committedProviderId, setCommittedProviderId, t]);

  // Every backend may be uninstalled: that is a state to show, not a crash.
  if (!effectiveId) {
    return (
      <Section title={t("provider.title")}>
        <div className="notice">{t("provider.none")}</div>
      </Section>
    );
  }

  const meta = providerMeta(effectiveId);
  const options = providerOptions[effectiveId] ?? {};
  const locked =
    connectionState === "connected" || connectionState === "connecting";
  const needsSignIn =
    meta.requiresAccount &&
    !accounts.some((a) => a.status === "ok" && a.provider === (meta.accountProviderId ?? meta.id));

  return (
    <Section title={meta.shortLabel} status={<ProviderStatusBadge provider={meta} />}>
      <div className="stack">
        <ProviderLimitNotice providerId={effectiveId} />
        <SelectField
          label={t("provider.backend")}
          value={effectiveId}
          disabled={locked}
          leading={<meta.icon size={13} />}
          options={available.map((option) => ({
            value: option.id,
            label: `${option.label} · ${t(option.releaseStage === "tested" ? "provider.tested" : "provider.beta")}`,
          }))}
          onChange={(value) => setProviderId(value)}
          help={meta.description}
        />

        {meta.releaseStage === "beta" && (
          <div className="notice">{t("provider.betaNotice", { backend: meta.shortLabel })}</div>
        )}

        {needsSignIn && (
          <div className="notice">{t("provider.needsSignIn")}</div>
        )}

        {/* Whatever this provider declared, in its own order. Two providers
            never share a value: the options are stored per provider. */}
        {meta.settings.map((field) => {
          const choices = field.optionsFor?.(language) ?? field.options;
          const stored = options[field.key];
          // A stored choice the current language does not offer shows the
          // first one, which is what the session falls back to as well.
          const value =
            choices && !choices.some((c) => c.value === stored)
              ? choices[0]?.value ?? ""
              : stored ?? "";
          return (
            <ProviderField
              key={field.key}
              field={field}
              choices={choices ?? []}
              value={value}
              disabled={locked}
              onChange={(next) => setProviderOption(effectiveId, field.key, next)}
            />
          );
        })}

        <div className="row between">
          <span className="muted small">{t("provider.session")}</span>
          <code>{sessions?.[effectiveId] ?? "—"}</code>
        </div>
      </div>
    </Section>
  );
}
/** One declared setting, rendered with the control its kind asks for. */
function ProviderField({
  field,
  choices,
  value,
  disabled,
  onChange,
}: {
  field: ProviderSettingField;
  choices: ProviderSettingOption[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  if (field.kind === "select") {
    return (
      <SelectField
        label={field.labelKey ? t(field.labelKey) : field.label ?? field.key}
        value={value}
        disabled={disabled}
        options={choices.map((c) => ({
          value: c.value,
          label: c.labelKey ? t(c.labelKey) : c.label,
        }))}
        onChange={onChange}
        help={field.helpKey ? t(field.helpKey) : undefined}
      />
    );
  }
  return (
    <TextField
      label={field.labelKey ? t(field.labelKey) : field.label ?? field.key}
      value={value}
      disabled={disabled}
      onChange={onChange}
      placeholder={field.placeholder}
      help={field.helpKey ? t(field.helpKey) : undefined}
    />
  );
}
