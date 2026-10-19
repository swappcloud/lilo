import { afterEach, describe, expect, it, vi } from "vitest";
import { isWakeWordSupported, useNativeEngine } from "./useWakeWord";

vi.mock("../../lib/gateway", async importOriginal => ({
  ...await importOriginal<typeof import("../../lib/gateway")>(),
  isTauri: () => true,
}));

describe("native wake selection", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["Linux x86_64", "Linux aarch64", "Windows NT 10.0", "Macintosh; Intel Mac OS X"])("uses the native contract on %s", agent => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
    expect(useNativeEngine()).toBe(true);
    expect(isWakeWordSupported()).toBe(true);
  });
});
