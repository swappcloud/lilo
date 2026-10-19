import { getCurrentWindow } from "@tauri-apps/api/window";
import { createRoot } from "react-dom/client";

import App from "./app/App";
import { PanelWindow } from "./app/PanelWindow";
import { watchShellStyle } from "./app/shellStyle";
import { armSplashFailsafe, removeSplash } from "./app/splash";
import { startPanelBridge } from "./app/windowBridge";
import { panelLaunch } from "./app/windowRole";
import { isTauri } from "./lib/gateway";
import { applyPreferences, usePreferencesStore } from "./store/preferencesStore";
import "./styles/index.css";

// Expose the OS for platform-specific CSS (e.g. the macOS overlay
// titlebar, where traffic lights float over the content).
{
  const ua = navigator.userAgent;
  document.documentElement.dataset.os = /Macintosh|Mac OS X/.test(ua)
    ? "macos"
    : /Windows/.test(ua)
      ? "windows"
      : "linux";
}

// The main window or the panel beside the companion: one bundle, two roots.
const launch = panelLaunch();
if (launch) {
  document.documentElement.dataset.window = "panel";
  // With the system's material behind it the page stays see-through.
  document.documentElement.dataset.material = launch.material ? "on" : "off";
}

// Classic window or desktop companion: the page background and the splash
// differ, so this is known before anything paints.
void watchShellStyle();

// Apply theme/accent before first paint to avoid a flash.
applyPreferences(usePreferencesStore.getState());

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found");
}

function show(): void {
  if (isTauri()) void getCurrentWindow().show().catch(() => {});
}

if (launch) {
  // A view of the main window: no splash, and nothing drawn before the
  // owner's state is in, so the first frame already shows the real values.
  removeSplash();
  // The window shows itself once its first view is committed (`PanelWindow`).
  void startPanelBridge().then(() => {
    createRoot(container).render(<PanelWindow launch={launch} />);
  });
} else {
  // Arm before anything else can throw: the splash must never outlive
  // startup, even if the rest of this file fails.
  armSplashFailsafe();

  // The window starts hidden: a fresh WKWebView paints white until its first
  // content frame, and that white frame is what the splash exists to remove.
  // The splash is already parsed by the time this module runs (the script is
  // deferred), so showing now means the first frame anyone sees is the logo.
  show();

  createRoot(container).render(<App />);
}
