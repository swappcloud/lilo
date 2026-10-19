import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useAlertStore } from "../../store/alertStore";
import { useMediaDevices } from "./useMediaDevices";
import { usePermissionWatch } from "./usePermissionWatch";
import { getMicrophone } from "../lib/microphone";

afterEach(() => { vi.unstubAllGlobals(); useAlertStore.setState({ micNeedsPermission: false, micAccessGranted: false }); });

it("clears the audio permission badge after access without a WebView2 devicechange event", async () => {
  const stop = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: {
    enumerateDevices: vi.fn().mockResolvedValue([{ kind: "audioinput", deviceId: "default", label: "" }]),
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } });
  let devices!: ReturnType<typeof useMediaDevices>;
  function Probe() { usePermissionWatch(); devices = useMediaDevices(); return null; }
  const host = document.createElement("div");
  const root = createRoot(host);
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => { root.render(createElement(Probe)); });
    expect(useAlertStore.getState().micNeedsPermission).toBe(true);
    await act(async () => { await devices.requestAccess(); });
    expect(stop).toHaveBeenCalledOnce();
    expect(useAlertStore.getState().micNeedsPermission).toBe(false);
    expect(devices.needsPermission).toBe(false);
    const media = navigator.mediaDevices;
    const watchers = vi.mocked(media.addEventListener).mock.calls;
    await act(async () => {
      for (const [, listener] of watchers) {
        if (typeof listener === "function") await listener.call(media, new Event("devicechange"));
      }
    });
    expect(useAlertStore.getState().micNeedsPermission).toBe(false);
    expect(devices.needsPermission).toBe(false);
  } finally { await act(async () => { root.unmount(); }); environment.IS_REACT_ACT_ENVIRONMENT = false; }
});

it("restores the badge when capture explicitly reports that permission was revoked", async () => {
  useAlertStore.getState().microphoneGranted();
  vi.stubGlobal("navigator", { mediaDevices: {
    getUserMedia: vi.fn().mockRejectedValue(new DOMException("Permission denied", "NotAllowedError")),
  } });
  await expect(getMicrophone({ audio: true })).rejects.toMatchObject({ name: "NotAllowedError" });
  expect(useAlertStore.getState().micNeedsPermission).toBe(true);
  expect(useAlertStore.getState().micAccessGranted).toBe(false);
});
