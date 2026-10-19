import { useEffect, useRef } from "react";

import { listen } from "@tauri-apps/api/event";

import { isTauri } from "../lib/gateway";
import { log } from "../lib/log";
import { useMediaStore } from "../store/mediaStore";
import { useSessionStore } from "../store/sessionStore";
import { ownerCall } from "./windowRole";
import { downloadDiagnosticLogs } from "../features/settings/diagnostics";

const MENU_EVENT = "lilo://menu";

/** The panels a native menu can open; each shell decides how it opens them. */
export interface PanelHandlers {
  settings: () => void;
  conversations: () => void;
  transcript: () => void;
  commands: () => void;
}

/** Start the session when idle, end it when live or on its way. */
export const toggleSession = ownerCall("session.toggle", (): void => {
  const { connectionState, connect, disconnect } = useSessionStore.getState();
  if (
    connectionState === "connected" ||
    connectionState === "connecting" ||
    connectionState === "reconnecting"
  ) {
    void disconnect();
  } else {
    void connect();
  }
});

function runMedia(tool: string): void {
  void useMediaStore
    .getState()
    .run(tool)
    .catch((error: unknown) => log("menu", `${tool} failed: ${String(error)}`));
}

/**
 * Actions picked in the native menus (the macOS menu bar, the tray, the
 * mascot's context menu). Rust handles showing, hiding and quitting itself and
 * forwards the rest here.
 */
export function useMenuActions(panels: PanelHandlers): void {
  // The listener is registered once; the latest handlers are read through a
  // ref so a re-render never leaves a stale one behind.
  const latest = useRef(panels);
  latest.current = panels;

  useEffect(() => {
    if (!isTauri()) return;
    const handle = (action: string) => {
      const session = useSessionStore.getState();
      const paused = useMediaStore.getState().nowPlaying?.paused ?? false;
      switch (action) {
        case "download-logs":
          void downloadDiagnosticLogs();
          break;
        case "session":
          void toggleSession();
          break;
        case "interrupt":
          session.interrupt();
          break;
        case "mute":
          session.toggleMute();
          break;
        case "media-toggle":
          runMedia(paused ? "media_resume" : "media_pause");
          break;
        case "media-next":
          runMedia("media_next");
          break;
        case "media-previous":
          runMedia("media_previous");
          break;
        case "media-stop":
          runMedia("media_stop");
          break;
        case "settings":
        case "conversations":
        case "transcript":
        case "commands":
          latest.current[action]();
          break;
        default:
          break;
      }
    };
    const pending = listen<string>(MENU_EVENT, (event) => handle(event.payload));
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);
}
