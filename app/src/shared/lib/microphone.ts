import { useAlertStore } from "../../store/alertStore";

/** Record actual microphone access even when the webview emits no devicechange. */
export async function getMicrophone(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone API is unavailable in this webview.");
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    useAlertStore.getState().microphoneGranted();
    return stream;
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && typeof error.name === "string"
      && ["NotAllowedError", "PermissionDeniedError"].includes(error.name)) {
      useAlertStore.getState().microphoneDenied();
    }
    throw error;
  }
}
