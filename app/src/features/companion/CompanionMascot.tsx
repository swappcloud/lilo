import { useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { useTranslation } from "../../i18n";
import { call, isTauri } from "../../lib/gateway";
import { isPlaying, useMediaStore } from "../../store/mediaStore";
import { accentColors, usePreferencesStore } from "../../store/preferencesStore";
import { useSessionStore } from "../../store/sessionStore";
import { useWakeStore } from "../../store/wakeStore";
import { MicOffIcon } from "../../shared/ui/icons";
import { LiloStage } from "../voice/lilo/LiloStage";
import { hexToRgb, type Rgb } from "../voice/orbRenderer";
import { useVoicePhase } from "../voice/useVoicePhase";
import { isWakeWordSupported } from "../voice/useWakeWord";

/** Pointer travel that turns a press into a drag instead of a click. */
const DRAG_THRESHOLD = 4;

interface Props {
  error: boolean;
}

/**
 * LILO itself. A click does what tapping LILO always did (start a session,
 * or interrupt a reply); pressing and moving drags the window; a right-click
 * opens the tray's menu where the pointer is.
 */
export function CompanionMascot({ error }: Props) {
  const { t } = useTranslation();
  const phase = useVoicePhase();
  const connectionState = useSessionStore((s) => s.connectionState);
  const muted = useSessionStore((s) => s.muted);
  const connect = useSessionStore((s) => s.connect);
  const interrupt = useSessionStore((s) => s.interrupt);
  const animations = usePreferencesStore((s) => s.animations);
  const accent = usePreferencesStore((s) => s.accent);
  const customAccent = usePreferencesStore((s) => s.customAccent);
  const music = isPlaying(useMediaStore((s) => s.nowPlaying));
  const wakeWord = usePreferencesStore((s) => s.wakeWord);
  const wakeBlocked = useWakeStore((s) => s.blocked);
  const wakePhrase = usePreferencesStore((s) => s.wakePhrase);
  const press = useRef<{ x: number; y: number; id: number } | null>(null);

  const accentRgb = useMemo<[Rgb, Rgb]>(() => {
    const swatch = accentColors({ accent, customAccent });
    return [hexToRgb(swatch.from), hexToRgb(swatch.to)];
  }, [accent, customAccent]);

  const live = connectionState === "connected";
  const speaking = phase === "speaking";

  const activate = () => {
    if (live) {
      if (speaking) interrupt();
      return;
    }
    if (connectionState === "idle" || connectionState === "disconnected") {
      void connect();
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    press.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = press.current;
    if (!start || start.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD) return;
    // The OS takes the drag from here (multi-monitor, snapping, scaling); the
    // pointer-up that would have been a click never arrives.
    press.current = null;
    if (isTauri()) {
      void getCurrentWindow()
        .startDragging()
        .catch(() => {});
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = press.current;
    press.current = null;
    if (start && start.id === event.pointerId) activate();
  };

  // Muted overrides "listening" in the halo: the badge alone was too easy to
  // miss, and the steady breathing glow otherwise looks identical to an open
  // mic — the one thing this state exists to make clear.
  const state = error ? "error" : music && !live ? "music" : live && muted ? "muted" : phase;
  // Idle LILO is either waiting for its name or asleep until clicked.
  const wake = wakeWord && !wakeBlocked && isWakeWordSupported() ? "armed" : "off";

  return (
    <>
      <div className="companion-mascot" data-lilo-anchor aria-hidden>
        <LiloStage phase={phase} animations={animations} music={music} accent={accentRgb} />
      </div>
      <div
        className="companion-body"
        data-hit
        data-state={state}
        data-wake={wake}
        role="button"
        tabIndex={0}
        aria-label={speaking ? t("stage.orbInterrupt") : t("stage.orbStart")}
        title={
          speaking
            ? t("companion.interrupt")
            : !live && wake === "armed"
              ? t("stage.sayToStart", { phrase: wakePhrase })
              : t("companion.talk")
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press.current = null;
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          press.current = null;
          if (isTauri()) void call<void>("shell_popup_menu").catch(() => {});
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") activate();
        }}
      />
      {live && muted && (
        <span className="companion-badge companion-badge--muted" title={t("companion.muted")}>
          <MicOffIcon size={13} />
        </span>
      )}
    </>
  );
}
