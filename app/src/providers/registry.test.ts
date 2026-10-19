import { describe, expect, it } from "vitest";
import "./registry";
import { loginProviderIds, providerIds } from "./contract";

describe("bundled provider registration", () => {
  it("does not expose Qwen without an installed provider plugin", () => {
    expect(providerIds()).not.toContain("qwen-web");
    expect(loginProviderIds()).not.toContain("qwen-web");
    expect(providerIds()).not.toContain("plugin:com.lilo.provider.qwen/web");
    expect(loginProviderIds()).not.toContain("plugin:com.lilo.provider.qwen/web");
  });
});
