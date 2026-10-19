import { create } from "zustand";
import type { ProviderQuota } from "../providers/types";

interface Report { account: string; quota: ProviderQuota; }
export function activeQuota(report: Report | undefined, account: string, now = Date.now()): ProviderQuota | null {
  if (!report || report.account !== account || (report.quota.retryAt !== undefined && report.quota.retryAt <= now)) return null;
  return report.quota;
}

/** Account-scoped reports in memory; refreshing the same profile does not reset its quota. */
export const useProviderLimits = create<{
  reports: Record<string, Report>;
  report: (provider: string, account: string, quota: ProviderQuota) => void;
}>((set) => ({
  reports: {},
  report: (provider, account, quota) => {
    if (quota.kind !== "daily" || account.length > 320 || /[\x00-\x1f\x7f]/.test(account)) return;
    const retryAt = quota.retryAt;
    if (retryAt !== undefined && (!Number.isFinite(retryAt) || retryAt <= Date.now() || retryAt > Date.now() + 30 * 86400_000)) return;
    set((state) => ({ reports: { ...state.reports, [provider]: { account, quota } } }));
  },
}));
