/**
 * Things the user has to authorise before a feature can work.
 *
 * Kept as app state rather than inside a settings section: the badge has to be
 * visible on the closed gear icon, and the settings page that owns the control
 * may never have been opened.
 */

import { create } from "zustand";

interface AlertStore {
  /** True while the OS/browser is hiding audio devices behind a prompt. */
  micNeedsPermission: boolean;
  setMicNeedsPermission: (needed: boolean) => void;
  /** Successful capture is stronger evidence than device labels in WebView2. */
  micAccessGranted: boolean;
  microphoneGranted: () => void;
  microphoneDenied: () => void;
}

export const useAlertStore = create<AlertStore>((set) => ({
  micNeedsPermission: false,
  micAccessGranted: false,
  setMicNeedsPermission: (needed) => set((state) => ({ micNeedsPermission: needed && !state.micAccessGranted })),
  microphoneGranted: () => set({ micAccessGranted: true, micNeedsPermission: false }),
  microphoneDenied: () => set({ micAccessGranted: false, micNeedsPermission: true }),
}));
