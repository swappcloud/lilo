import { useEffect } from "react";

export interface ShortcutHandlers {
  onToggleSession: () => void;
  onToggleTranscript: () => void;
  onToggleSettings: () => void;
  onToggleConversations: () => void;
  onToggleCommands: () => void;
  onEscape: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/** Space toggle · T transcript · C conversations · H commands · A settings · Esc. */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;

      switch (event.code === "Space" ? "space" : event.key.toLowerCase()) {
        case "space":
          event.preventDefault();
          handlers.onToggleSession();
          break;
        case "t":
          handlers.onToggleTranscript();
          break;
        case "c":
          handlers.onToggleConversations();
          break;
        case "h":
          handlers.onToggleCommands();
          break;
        case "a":
          handlers.onToggleSettings();
          break;
        case "escape":
          handlers.onEscape();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlers]);
}