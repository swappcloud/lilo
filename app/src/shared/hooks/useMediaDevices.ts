import { useCallback, useEffect, useState } from "react";

import { ownerCall } from "../../app/windowRole";
import { translate } from "../../i18n";
import { useAlertStore } from "../../store/alertStore";
import { getMicrophone } from "../lib/microphone";

export interface MediaDevice {
  deviceId: string;
  label: string;
}

function toDevice(device: MediaDeviceInfo, index: number): MediaDevice {
  const fallback =
    device.kind === "audioinput"
      ? translate("devices.microphone")
      : translate("devices.output");
  return {
    deviceId: device.deviceId,
    label: device.label || `${fallback} ${index + 1}`,
  };
}

/** True when the webview can route audio to a specific output device. */
export const supportsOutputSelection =
  typeof window !== "undefined" &&
  typeof HTMLMediaElement !== "undefined" &&
  "setSinkId" in HTMLMediaElement.prototype;

interface AudioDevices {
  inputs: MediaDevice[];
  outputs: MediaDevice[];
  needsPermission: boolean;
}

/**
 * The devices as the owner window sees them. Permission is per page, and the
 * microphone is used (and granted) in the owner, so the panel asks it rather
 * than enumerating a page that was never granted anything.
 */
const readDevices = ownerCall("devices.read", async (): Promise<AudioDevices | null> => {
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioIn = devices.filter((device) => device.kind === "audioinput");
    const audioOut = devices.filter((device) => device.kind === "audiooutput");
    return {
      inputs: audioIn.map(toDevice),
      outputs: audioOut.map(toDevice),
      // No devices at all, or every label blank, means the browser is hiding
      // them behind the permission gate rather than the machine having none.
      needsPermission: !useAlertStore.getState().micAccessGranted && (audioIn.length === 0 || audioIn.every((device) => !device.label)),
    };
  } catch {
    return { inputs: [], outputs: [], needsPermission: !useAlertStore.getState().micAccessGranted };
  }
});

/**
 * Ask for the microphone. The stream is released immediately — we only ever
 * wanted the permission, not the audio.
 */
const requestMicrophone = ownerCall("devices.access", async (): Promise<void> => {
  const stream = await getMicrophone({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
});

/**
 * Enumerate input/output audio devices and keep the list fresh.
 *
 * Until microphone permission is granted the browser hides the hardware: WebKit
 * returns an **empty** list, Chromium returns entries with blank labels. Either
 * way the picker looks broken — an external mic that is plugged in simply never
 * shows up. So the hook reports that state and offers a way out of it, instead
 * of enumerating into the void.
 */
export function useMediaDevices() {
  const [inputs, setInputs] = useState<MediaDevice[]>([]);
  const [outputs, setOutputs] = useState<MediaDevice[]>([]);
  const [needsPermission, setNeedsPermission] = useState(false);

  const refresh = useCallback(async () => {
    let devices: AudioDevices | null;
    try {
      devices = await readDevices();
    } catch {
      devices = { inputs: [], outputs: [], needsPermission: true };
    }
    if (!devices) return;
    setInputs(devices.inputs);
    setOutputs(devices.outputs);
    setNeedsPermission(devices.needsPermission);
  }, []);

  const requestAccess = useCallback(async () => {
    await requestMicrophone();
    await refresh();
  }, [refresh]);

  // Granting access in the owner is noticed there; follow it here too.
  const ownerNeedsPermission = useAlertStore((s) => s.micNeedsPermission);

  useEffect(() => {
    void refresh();
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return;
    // Plugging a headset in or out changes the list; the picker must follow.
    media.addEventListener("devicechange", refresh);
    return () => media.removeEventListener("devicechange", refresh);
  }, [refresh, ownerNeedsPermission]);

  return {
    inputs,
    outputs,
    refresh,
    requestAccess,
    needsPermission,
    supportsOutputSelection,
  };
}
