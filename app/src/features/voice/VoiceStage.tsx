import { useMemo, useRef } from "react";

import { accentColors, usePreferencesStore } from "../../store/preferencesStore";
import { isPlaying, useMediaStore } from "../../store/mediaStore";
import { selectActiveConversation, useSessionStore } from "../../store/sessionStore";
import { useTranslation, type Translate } from "../../i18n";
import { LiloStage } from "./lilo/LiloStage";
import { OrbCanvas } from "./OrbCanvas";
import { hexToRgb, type Rgb, type VoicePhase } from "./orbRenderer";
import { isWakeWordSupported } from "./useWakeWord";
import { useSessionTimer, useVoicePhase } from "./useVoicePhase";

function captions(t: Translate): Record<VoicePhase, { title: string; sub: string }> {
  return {
    idle: { title: t("stage.idleTitle"), sub: t("stage.idleSub") },
    listening: {
      title: t("stage.listeningTitle"),
      sub: t("stage.listeningSub"),
    },
    thinking: { title: t("stage.thinkingTitle"), sub: t("stage.thinkingSub") },
    speaking: { title: t("stage.speakingTitle"), sub: t("stage.speakingSub") },
  };
}

export function VoiceStage() {
  const { t } = useTranslation();
  const orbRef = useRef<HTMLDivElement>(null);

  const phase = useVoicePhase();
  const connectionState = useSessionStore((s) => s.connectionState);
  const micLevel = useSessionStore((s) => s.micLevel);
  const outputLevel = useSessionStore((s) => s.outputLevel);
  const interrupt = useSessionStore((s) => s.interrupt);
  const connect = useSessionStore((s) => s.connect);
  const conversation = useSessionStore(selectActiveConversation);
  const viz = usePreferencesStore((s) => s.viz);
  const animations = usePreferencesStore((s) => s.animations);
  const accent = usePreferencesStore((s) => s.accent);
  const customAccent = usePreferencesStore((s) => s.customAccent);
  const wakeWord = usePreferencesStore((s) => s.wakeWord);
  const wakePhrase = usePreferencesStore((s) => s.wakePhrase);
  const timer = useSessionTimer();
  // Music has no WebAudio spectrum to read; the visual moves on its own so the
  // animation stays in one place.
  const music = isPlaying(useMediaStore((s) => s.nowPlaying));

  const accentRgb = useMemo<[Rgb, Rgb]>(() => {
    const swatch = accentColors({ accent, customAccent });
    return [hexToRgb(swatch.from), hexToRgb(swatch.to)];
  }, [accent, customAccent]);

  const energy = phase === "speaking" ? outputLevel : micLevel;

  const live = connectionState === "connected";
  const speaking = phase === "speaking";
  const muted = useSessionStore((s) => s.muted);
  // A muted session is still listening in name only: the app cannot hear a
  // thing, and saying "Listening…" over a playing track was a lie.
  const caption =
    live && muted && !speaking
      ? { title: t("stage.mutedTitle"), sub: t("stage.mutedSub") }
      : captions(t)[phase];
  const lastTurn = conversation?.turns[conversation.turns.length - 1];
  // Only promise voice activation when the webview can actually do it.
  const wakeReady = wakeWord && isWakeWordSupported();
  const sub =
    live && lastTurn?.text
      ? lastTurn.text
      : !live && wakeReady
        ? t("stage.sayToStart", { phrase: wakePhrase })
        : !live && wakeWord
          ? t("stage.wakeNeedsDesktop")
          : caption.sub;

  const onOrbActivate = () => {
    if (connectionState === "connected") {
      if (speaking) interrupt();
      return;
    }
    if (connectionState === "idle" || connectionState === "disconnected") {
      void connect();
    }
  };

  return (
    <>
      {viz !== "lilo" && (
        <OrbCanvas
          targetRef={orbRef}
          phase={phase}
          energy={energy}
          viz={viz}
          animations={animations}
          accent={accentRgb}
          music={music}
        />
      )}

      {/* Empty space drags the window: every control inside stays clickable
          (buttons and links block the drag region), so the window can be moved
          from wherever the user happens to grab it. */}
      <main className="stage" data-tauri-drag-region="deep">
        <div
          ref={orbRef}
          className="orbwrap"
          onClick={onOrbActivate}
          role="button"
          tabIndex={0}
          aria-label={speaking ? t("stage.orbInterrupt") : t("stage.orbStart")}
          onKeyDown={(event) => {
            if (event.key === "Enter") onOrbActivate();
          }}
        >
          {viz === "lilo" && (
            <LiloStage
              phase={phase}
              animations={animations}
              music={music}
              accent={accentRgb}
            />
          )}
        </div>

        <div className="caption" key={phase}>
          <h1>{caption.title}</h1>
          <p>{sub}</p>
        </div>

        {timer.active && <div className="pill mono">{timer.label}</div>}

        {/* One way to interrupt on screen: tapping LILO (the dock's stop ends
            the call). A second stop button next to it read as a duplicate. */}
        {speaking && <p className="hint">{t("stage.bargeHint")}</p>}
      </main>
    </>
  );
}