import { describe, expect, it } from "vitest";
import { activeQuota, useProviderLimits } from "./providerLimits";
describe("provider quota reports", () => {
  it("isolates accounts and expires only at the reported retry time", () => {
    const report = { account: "fixture-account", quota: { kind: "daily" as const, retryAt: 2000 } };
    expect(activeQuota(report, "fixture-account", 1000)).toEqual(report.quota);
    expect(activeQuota(report, "other-account", 1000)).toBeNull();
    expect(activeQuota(report, "fixture-account", 2000)).toBeNull();
  });
  it("stores independent provider limits and rejects invalid deadlines", () => {
    useProviderLimits.setState({ reports: {} });
    useProviderLimits.getState().report("fixture-one", "account", { kind: "daily", retryAt: Date.now() + 3600_000 });
    useProviderLimits.getState().report("fixture-two", "account", { kind: "daily" });
    useProviderLimits.getState().report("invalid", "account", { kind: "daily", retryAt: Infinity });
    expect(Object.keys(useProviderLimits.getState().reports)).toEqual(["fixture-one", "fixture-two"]);
    expect(activeQuota(useProviderLimits.getState().reports["fixture-two"], "account")).toEqual({ kind: "daily" });
  });
});
