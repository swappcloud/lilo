import { useEffect, useState, type ReactNode } from "react";

import { listen } from "@tauri-apps/api/event";

import { toggleSession, useMenuActions } from "../../app/useMenuActions";
import type { PanelName } from "../../app/windowRole";
import { call, isTauri } from "../../lib/gateway";
import { log } from "../../lib/log";
import { useConfirmStore } from "../../store/confirmStore";
import { useGeneratedImageStore, type ShownImage } from "../../store/generatedImages";
import { isPlaying, useMediaStore } from "../../store/mediaStore";
import { useSessionStore } from "../../store/sessionStore";
import { useToastStore } from "../../store/toastStore";
import { useTranslation } from "../../i18n";
import { useKeyboardShortcuts } from "../../shared/hooks/useKeyboardShortcuts";
import { SceneLayer } from "../scene/SceneLayer";
import { ConfirmBar } from "../voice/ConfirmBar";
import { useVoicePhase } from "../voice/useVoicePhase";
import { CompanionMascot } from "./CompanionMascot";
import { bubbleSide, type Space } from "./geometry";
import { MediaRing, QueuePopover, VolumePopover, type MediaPopover } from "./MediaRing";
import { useHitRegions } from "./useHitRegions";
import { usePointerHover } from "./usePointerHover";
import { usePresence } from "./usePresence";
import { useSpeech } from "./useSpeech";

const SPACE_EVENT = "lilo://companion-space";
/** How long an error stays on LILO before it goes back to normal. */
const ERROR_MS = 6_000;
const BUBBLE_EXIT_MS = 320;
/** The media buttons leave one after another; the last one is gone by then. */
const RING_EXIT_MS = 440;

/**
 * Settings and history open in their own window beside LILO (`PanelWindow`);
 * this one never changes frame, so LILO stays where it is.
 */
function openPanel(panel: PanelName): void {
  if (!isTauri()) return;
  void call<void>("shell_panel", { panel }).catch((reason: unknown) =>
    log("companion", `panel failed: ${String(reason)}`),
  );
}

/** Where the bubble may go: the side of the mascot with room on screen. */
function useBubbleSide() {
  const [space, setSpace] = useState<Space | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    call<Space | null>("shell_space").then(setSpace, () => {});
    const pending = listen<Space>(SPACE_EVENT, (event) => setSpace(event.payload));
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);
  return bubbleSide(space);
}

/** The latest session error, for a moment, then gone. */
function useRecentError(): string | null {
  const lastError = useSessionStore((s) => s.lastError);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!lastError) {
      setShown(null);
      return;
    }
    setShown(lastError);
    const timer = window.setTimeout(() => setShown(null), ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [lastError]);
  return shown;
}

/** How many of the newest words are lit while LILO says them. */
const FRESH_WORDS = 4;

/**
 * Three kinds of bubble: `speech` is LILO talking (a tail to its mouth),
 * `thought` is LILO thinking or noting something to itself — the wait while
 * it connects, a notice, an error (a cloud). `tool` holds controls.
 */
function Thinking({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div className="thinking" aria-label={label ?? t("companion.thinking")}>
      <span className="thinking-dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span className="thinking-hmm" aria-hidden>
        {label ?? "hmm…"}
      </span>
    </div>
  );
}

/** LILO's words, with the newest ones lit while they are being spoken. */
function Speech({ text, live }: { text: string; live: boolean }) {
  const words = text.split(/\s+/).filter(Boolean);
  const cut = live ? Math.max(0, words.length - FRESH_WORDS) : words.length;
  return (
    <>
      <div className="bubble-voice" aria-hidden>
        <span className="bubble-wave" data-live={live}>
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        LILO
      </div>
      <div className="bubble-scroll">
        <p className="bubble-text">
          {/* Keyed by position: a word animates once, when it first arrives. */}
          {words.map((word, i) => (
            <span key={i} className={i < cut ? "bubble-word" : "bubble-word bubble-fresh"}>
              {i === words.length - 1 ? word : `${word} `}
            </span>
          ))}
        </p>
      </div>
    </>
  );
}

/** A note to itself: an icon, then the words. */
function Note({ text, error }: { text: string; error?: boolean }) {
  return (
    <p className="bubble-text">
      <svg className="bubble-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="6.8" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path
          d={error ? "M8 4.4v4.3M8 11.3v.1" : "M8 7.2v4.2M8 4.6v.1"}
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      </svg>
      {text}
    </p>
  );
}

/** A picture LILO was asked to make, shown big enough to see; a click puts it away. */
function Picture({ image }: { image: ShownImage }) {
  const { t } = useTranslation();
  const dismiss = useGeneratedImageStore((s) => s.dismiss);
  const label = image.prompt || t("companion.picture");
  return (
    <button type="button" className="bubble-picture" onClick={dismiss} title={t("companion.pictureDismiss")}>
      <img src={image.src} alt={label} />
    </button>
  );
}

/** The curved tail of LILO's mark, pointing the speech bubble at its mouth. */
function SpeechTail() {
  return (
    <svg className="bubble-tail" viewBox="0 0 30 26" aria-hidden>
      <path className="tail-fill" d="M10,1 L13.75,1 C13.75,15 19,24 30,28 Q20,25.25 8,25.25 L8,24.4 L10,24.4 Z" />
      <path className="tail-edge" d="M13.75,1 C13.75,15 19,24 30,28 Q20,25.25 8,25.25" />
    </svg>
  );
}

interface BubbleContent {
  key: string;
  shape: "speech" | "thought" | "tool";
  error?: boolean;
  /** A thought LILO is having (not a note): the cloud trails back to it. */
  thinking?: boolean;
  /** A picture: the thought grows to show it. */
  picture?: boolean;
  body: ReactNode;
}

/**
 * The desktop companion: LILO alone on the desktop, its speech bubble, and
 * the media controls while music is loaded. Settings and history open in
 * the panel window; the voice session stays here.
 */
export function CompanionShell() {
  const [popover, setPopover] = useState<MediaPopover | null>(null);
  const side = useBubbleSide();
  const speech = useSpeech();
  const error = useRecentError();
  const toast = useToastStore((s) => s.message);
  const confirm = useConfirmStore((s) => s.command);
  const playing = isPlaying(useMediaStore((s) => s.nowPlaying));
  const connecting = useVoicePhase() === "thinking";
  const speaking = useSessionStore((s) => s.assistantSpeaking);
  const picture = useGeneratedImageStore((s) => s.shown);
  const drawing = useGeneratedImageStore((s) => s.pending);
  const imageProgress = useGeneratedImageStore((s) => s.progress);
  const { t } = useTranslation();

  useMenuActions({
    settings: () => openPanel("settings"),
    conversations: () => openPanel("conversations"),
    transcript: () => openPanel("transcript"),
    commands: () => openPanel("commands"),
  });

  useKeyboardShortcuts({
    onToggleSession: () => void toggleSession(),
    onToggleTranscript: () => openPanel("transcript"),
    onToggleSettings: () => openPanel("settings"),
    onToggleConversations: () => openPanel("conversations"),
    onToggleCommands: () => openPanel("commands"),
    onEscape: () => setPopover(null),
  });

  useHitRegions();
  usePointerHover();

  // The popovers belong to the music: they go when it does.
  useEffect(() => {
    if (!playing) setPopover(null);
  }, [playing]);

  // One bubble at a time, most urgent first: a question that needs an
  // answer, what the user just opened, an error, a picture it was asked to
  // make (it outranks the words that announce it), LILO's words, a note, and
  // the wait while it connects.
  const content: BubbleContent | null = confirm
    ? { key: `confirm-${confirm}`, shape: "speech", body: <ConfirmBar /> }
    : popover === "volume"
      ? { key: "volume", shape: "tool", body: <VolumePopover /> }
      : popover === "queue"
        ? { key: "queue", shape: "tool", body: <QueuePopover /> }
        : error
          ? { key: `error-${error}`, shape: "thought", error: true, body: <Note text={error} error /> }
          : picture
            ? {
                key: `picture-${picture.id}`,
                shape: "thought",
                thinking: true,
                picture: true,
                body: <Picture image={picture} />,
              }
            : speech
              ? { key: "speech", shape: "speech", body: <Speech text={speech} live={speaking} /> }
              : drawing
                ? {
                    key: "drawing",
                    shape: "thought",
                    thinking: true,
            body: <Thinking label={imageProgress === null ? t("companion.creatingImage") : t("companion.creatingImageProgress", { percent: imageProgress })} />,
                  }
                : toast
                ? { key: `toast-${toast}`, shape: "thought", body: <Note text={toast} /> }
                : connecting
                  ? { key: "connecting", shape: "thought", thinking: true, body: <Thinking /> }
                  : null;
  const bubble = usePresence(content, BUBBLE_EXIT_MS);
  const ring = usePresence(playing ? true : null, RING_EXIT_MS);

  return (
    <div className="companion" data-side={side} data-music={playing ? "on" : "off"}>
      <SceneLayer />
      {bubble.shown && (
        <div
          key={bubble.shown.key}
          className={`companion-bubble companion-bubble--${bubble.shown.shape}${
            bubble.shown.error ? " companion-bubble--error" : ""
          }${bubble.shown.picture ? " companion-bubble--picture" : ""}`}
          data-hit
          data-leaving={bubble.leaving ? "true" : undefined}
          role={bubble.shown.error ? "alert" : "status"}
          aria-live="polite"
        >
          <div className="companion-bubble-inner">
            {bubble.shown.shape === "thought" && (
              <>
                <i className="cloud-bump" />
                <i className="cloud-bump" />
                <i className="cloud-bump" />
              </>
            )}
            {bubble.shown.body}
          </div>
          {bubble.shown.shape === "speech" && <SpeechTail />}
          {bubble.shown.thinking && (
            <>
              <i className="cloud-puff cloud-puff--near" />
              <i className="cloud-puff cloud-puff--far" />
            </>
          )}
        </div>
      )}
      <CompanionMascot error={!!error} />
      {ring.shown && <MediaRing leaving={ring.leaving} popover={popover} onPopover={setPopover} />}
    </div>
  );
}
