import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LoginStatus } from "../lib/gateway";
const fixture = vi.hoisted(() => ({ callback: null as null | ((status: LoginStatus) => void), off: vi.fn() }));
vi.mock("../lib/gateway", async (original) => ({
  ...await original<typeof import("../lib/gateway")>(),
  onProviderLoginStatus: async (callback: (status: LoginStatus) => void) => { fixture.callback = callback; return fixture.off; },
}));
vi.mock("../providers", async (original) => ({
  ...await original<typeof import("../providers")>(),
  providerLogin: () => ({ selectOnSuccess: true }),
}));
import { useSessionStore } from "./sessionStore";
let cleanup: () => void;
const select = vi.fn();
const refresh = vi.fn().mockResolvedValue(undefined);
const initial = useSessionStore.getState();
beforeEach(async () => {
  vi.clearAllMocks();
  useSessionStore.setState({ ...initial, loginStatus: "idle", loginProvider: undefined, setProviderId: select, refreshAccounts: refresh });
  cleanup = await useSessionStore.getState().initLoginListener();
});
afterEach(() => { cleanup(); useSessionStore.setState(initial); });
it("refresh and background identity events never change the selected provider", () => {
  fixture.callback?.({ provider: "fixture-web", status: "ok", email: "fixture-account" });
  expect(select).not.toHaveBeenCalled();
  expect(refresh).toHaveBeenCalledOnce();
});
it("only the explicitly requested login selects its provider once", () => {
  useSessionStore.setState({ loginStatus: "waiting", loginProvider: "fixture-web" });
  fixture.callback?.({ provider: "fixture-web", status: "ok", email: "fixture-account" });
  fixture.callback?.({ provider: "fixture-web", status: "ok", email: "fixture-account" });
  expect(select).toHaveBeenCalledExactlyOnceWith("fixture-web");
});
it("a late event from a different provider cannot replace the active login", () => {
  useSessionStore.setState({ loginStatus: "waiting", loginProvider: "fixture-web" });
  fixture.callback?.({ provider: "grok-web", status: "ok", email: "fixture-account" });
  expect(select).not.toHaveBeenCalled();
  expect(useSessionStore.getState().loginStatus).toBe("waiting");
  fixture.callback?.({ provider: "fixture-web", status: "ok", email: "fixture-account" });
  expect(select).toHaveBeenCalledExactlyOnceWith("fixture-web");
});
