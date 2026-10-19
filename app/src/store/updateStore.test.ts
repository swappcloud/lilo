import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo } from "./updateStore";

const native = vi.hoisted(() => ({ call: vi.fn(), listen: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/gateway", () => ({ APP_VERSION: "0.1.1", isTauri: () => true, call: native.call }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("./toastStore", () => ({ toast: native.toast }));
vi.mock("../i18n", () => ({ translate: (key: string) => key }));
import { useUpdateStore, watchUpdates } from "./updateStore";

const available: UpdateInfo = {
  status: "available", currentVersion: "0.1.1", version: "0.1.2", notes: null, progress: null, error: null, installable: true,
};
describe("signed desktop update observer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    useUpdateStore.setState({ info: null });
    native.listen.mockResolvedValue(vi.fn());
    native.call.mockResolvedValue(available);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("checks automatically but installs only on explicit request for the offered version", async () => {
    const stop = watchUpdates(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(native.call).toHaveBeenCalledWith("app_update_check");
    expect(native.call).not.toHaveBeenCalledWith("app_update_install", expect.anything());
    await useUpdateStore.getState().install();
    expect(native.call).toHaveBeenCalledWith("app_update_install", { version: "0.1.2" });
    stop();
  });

  it("keeps a newer event when the initial snapshot arrives late", async () => {
    let snapshot!: (info: UpdateInfo) => void;
    let emit!: (event: { payload: UpdateInfo }) => void;
    native.call.mockImplementation(() => new Promise<UpdateInfo>((resolve) => { snapshot = resolve; }));
    native.listen.mockImplementation((_name, handler) => { emit = handler; return Promise.resolve(vi.fn()); });
    const stop = watchUpdates();
    await Promise.resolve();
    emit({ payload: available });
    snapshot({ ...available, status: "idle", version: null });
    await Promise.resolve();
    expect(useUpdateStore.getState().info?.status).toBe("available");
    stop();
  });

  it("removes a listener resolved after cleanup and cancels scheduled checks", async () => {
    let subscribed!: (off: () => void) => void;
    const off = vi.fn();
    native.listen.mockImplementation(() => new Promise((resolve) => { subscribed = resolve; }));
    const stop = watchUpdates(true);
    stop();
    subscribed(off);
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);
    expect(off).toHaveBeenCalledOnce();
    expect(native.call).not.toHaveBeenCalledWith("app_update_check");
  });
});
