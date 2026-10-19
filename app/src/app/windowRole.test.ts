import { afterEach, describe, expect, it } from "vitest";

import { isOwnerWindow, ownerCall, panelLaunch, runOwnerCall, setOwnerRemote } from "./windowRole";

afterEach(() => {
  delete window.__LILO_PANEL__;
  setOwnerRemote(null);
});

describe("window role", () => {
  it("is the owner unless Rust opened it as a panel", () => {
    expect(isOwnerWindow()).toBe(true);
    window.__LILO_PANEL__ = { panel: "conversations", material: true };
    expect(panelLaunch()).toEqual({ panel: "conversations", material: true });
    expect(isOwnerWindow()).toBe(false);
  });

  it("falls back to settings for a panel it does not know", () => {
    window.__LILO_PANEL__ = { panel: "nope" };
    expect(panelLaunch()).toEqual({ panel: "settings", material: false });
  });

  it("runs an owner call in place in the owner", async () => {
    const double = ownerCall("test.double", (n: number) => n * 2);
    expect(await double(4)).toBe(8);
    expect(runOwnerCall("test.double", [5])).toBe(10);
  });

  it("sends an owner call across from a panel", async () => {
    const seen: unknown[] = [];
    const add = ownerCall("test.add", (a: number, b: number) => a + b);
    window.__LILO_PANEL__ = { panel: "settings" };
    await expect(add(1, 2)).rejects.toThrow(/bridge/);
    setOwnerRemote(async (name, args) => {
      seen.push(name, args);
      return runOwnerCall(name, args);
    });
    expect(await add(1, 2)).toBe(3);
    expect(seen).toEqual(["test.add", [1, 2]]);
  });
});
