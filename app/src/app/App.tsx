import { useEffect } from "react";

import { CompanionShell } from "../features/companion/CompanionShell";
import { AppShell } from "./AppShell";
import { useShellStyle } from "./shellStyle";
import { useAppRuntime } from "./useAppRuntime";
import { useApplyPreferences } from "./useApplyPreferences";
import { useBootstrap } from "./useBootstrap";
import { useShellState } from "./useShellState";
import { startOwnerBridge } from "./windowBridge";
import { UpdatePrompt } from "../features/settings/UpdatePrompt";

/**
 * Composition root of the main window: wires side effects, then renders the
 * shell — the classic window or the desktop companion. The runtime lives
 * here, above both, so switching shells never interrupts a session, the wake
 * word or the music. This window owns the state; the panel window only views
 * it through the bridge.
 */
export default function App() {
  useApplyPreferences();
  useBootstrap();
  useAppRuntime();
  useShellState();
  useEffect(() => startOwnerBridge(), []);
  const style = useShellStyle((s) => s.style);
  return <><UpdatePrompt />{style === "companion" ? <CompanionShell /> : <AppShell />}</>;
}
