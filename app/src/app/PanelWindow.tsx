import { useEffect, useState } from "react";

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { CommandsPanel } from "../features/commands/CommandsPanel";
import { ConversationRail } from "../features/conversations/ConversationRail";
import { SettingsPanel } from "../features/settings/SettingsPanel";
import { TranscriptPanel } from "../features/transcript/TranscriptPanel";
import { call, isTauri } from "../lib/gateway";
import { log } from "../lib/log";
import { useKeyboardShortcuts } from "../shared/hooks/useKeyboardShortcuts";
import { Toast } from "../shared/ui/Toast";
import { useApplyPreferences } from "./useApplyPreferences";
import { toggleSession } from "./useMenuActions";
import { isPanelName, type PanelLaunch, type PanelName } from "./windowRole";

const PANEL_EVENT = "lilo://panel";

/**
 * Rust creates the window hidden (a fresh webview paints white). Shown from
 * here, after the first commit — never from `requestAnimationFrame`, which
 * does not run in a hidden window, so the panel would wait for a second
 * click to appear.
 */
function showWindow(): void {
  if (!isTauri()) return;
  const current = getCurrentWindow();
  void current
    .show()
    .then(() => current.setFocus())
    .catch((reason: unknown) => log("panel", `show failed: ${String(reason)}`));
}

function closeWindow(): void {
  if (!isTauri()) return;
  void getCurrentWindow()
    .close()
    .catch(() => {});
}

/**
 * Switch views through Rust, which also sizes the window for the view; the
 * view itself changes on the event that comes back, like when a menu asks.
 */
function showPanel(panel: PanelName): void {
  if (!isTauri()) return;
  void call<void>("shell_panel", { panel }).catch((reason: unknown) =>
    log("panel", `switch failed: ${String(reason)}`),
  );
}

/**
 * Root of the panel window: settings and history beside the companion. It
 * runs no session and stores nothing — its stores mirror the main window's
 * (`windowBridge.ts`) — so closing it is a plain close.
 */
export function PanelWindow({ launch }: { launch: PanelLaunch }) {
  useApplyPreferences();
  const [panel, setPanel] = useState<PanelName>(launch.panel);

  useEffect(showWindow, []);

  useEffect(() => {
    if (!isTauri()) return;
    const pending = listen<string>(PANEL_EVENT, (event) => {
      if (isPanelName(event.payload)) setPanel(event.payload);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  const toggle = (next: PanelName) => (next === panel ? closeWindow() : showPanel(next));

  useKeyboardShortcuts({
    onToggleSession: () => void toggleSession(),
    onToggleTranscript: () => toggle("transcript"),
    onToggleSettings: () => toggle("settings"),
    onToggleConversations: () => toggle("conversations"),
    onToggleCommands: () => toggle("commands"),
    // Settings handles its own Escape: it drops the draft first.
    onEscape: () => {
      if (panel !== "settings") closeWindow();
    },
  });

  return (
    <div className="panel-window">
      {panel === "settings" && <SettingsPanel open onClose={closeWindow} />}
      {panel === "transcript" && <TranscriptPanel open onClose={closeWindow} />}
      {panel === "commands" && <CommandsPanel open onClose={closeWindow} />}
      {panel === "conversations" && (
        <ConversationRail open onClose={closeWindow} onOpenTranscript={() => showPanel("transcript")} />
      )}
      <Toast />
    </div>
  );
}
