import type { ProviderMeta } from "../../providers";
import { useTranslation } from "../../i18n";
import { StatusBadge } from "../../shared/ui/StatusBadge";

/** A live validation label, independent of the provider's vendor. */
export function ProviderStatusBadge({ provider }: { provider: ProviderMeta }) {
  const { t } = useTranslation();
  const tested = provider.releaseStage === "tested";
  return <StatusBadge tone={tested ? "positive" : "neutral"}
    title={t(tested ? "provider.testedHelp" : "provider.betaHelp")}>{t(tested ? "provider.tested" : "provider.beta")}</StatusBadge>;
}
