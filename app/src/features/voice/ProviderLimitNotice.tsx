import { useEffect, useState } from "react";
import { useTranslation } from "../../i18n";
import { providerMeta } from "../../providers";
import { useSessionStore } from "../../store/sessionStore";
import { activeQuota, useProviderLimits } from "../../store/providerLimits";

export function ProviderLimitNotice({ providerId }: { providerId?: string }) {
  const { t, locale } = useTranslation();
  const selected = useSessionStore((state) => state.providerId);
  const provider = providerId ?? selected;
  const owner = providerMeta(provider).accountProviderId ?? provider;
  const account = useSessionStore((state) => state.accounts.find((item) => item.provider === owner)?.email ?? "");
  const report = useProviderLimits((state) => state.reports[owner]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const quota = activeQuota(report, account, now);
  if (!quota) return null;
  const backend = providerMeta(provider).shortLabel;
  return <div className="notice" role="status">
    {quota.retryAt ? t("session.voiceLimitRetry", { backend, time: new Date(quota.retryAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) })
      : t("session.voiceLimit", { backend })}
  </div>;
}
