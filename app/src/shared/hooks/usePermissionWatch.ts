import { useEffect } from "react";

import { useAlertStore } from "../../store/alertStore";

/**
 * Watches for permissions the app needs, app-wide.
 *
 * Devices stay hidden and unlabelled until the microphone is granted once, so
 * "no audio devices" and "not allowed yet" look identical from the UI. This
 * publishes that state so the settings entry point can show a badge without
 * the Audio devices page being open.
 */
export function usePermissionWatch(): void {
  const setMicNeedsPermission = useAlertStore((s) => s.setMicNeedsPermission);

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    const check = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter((device) => device.kind === "audioinput");
        // No inputs at all, or every label blank: the browser is gating them.
        setMicNeedsPermission(
          inputs.length === 0 || inputs.every((device) => !device.label),
        );
      } catch {
        setMicNeedsPermission(true);
      }
    };

    void check();
    const media = navigator.mediaDevices;
    if (!media.addEventListener) return;
    // Granting access (or plugging a device in) changes the answer.
    media.addEventListener("devicechange", check);
    return () => media.removeEventListener("devicechange", check);
  }, [setMicNeedsPermission]);
}