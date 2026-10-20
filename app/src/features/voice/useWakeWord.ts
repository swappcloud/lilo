import { useCallback, useEffect, useRef, useState } from "react";

import {
  handleLocalUtterance,
  isTauri,
  onLocalVoiceTranscript,
  onWakeBlocked,
  onWakeWord,
  setWakeWatch,
} from "../../lib/gateway";
import { log, logError } from "../../lib/log";
import { onSatelliteActivate } from "../../providers/chatgpt/gateway";
import { effectiveGreeting, usePreferencesStore } from "../../store/preferencesStore";
import { useSessionStore } from "../../store/sessionStore";
import { useWakeStore } from "../../store/wakeStore";
import { LocalVoiceController } from "../../store/localVoice";
import { usePluginsStore } from "../../store/pluginsStore";

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * macOS (WKWebView) has no Web Speech API and Windows (WebView2) has no
 * speech service behind it, so the wake word runs in the native Rust engine
 * there. Linux uses the shared local keyword engine through the same contract.
 */
export function useNativeEngine(): boolean {
  return isTauri() && /Macintosh|Mac OS X|Windows|Linux/.test(navigator.userAgent);
}

export function isWakeWordSupported(): boolean {
  if (typeof navigator !== "undefined" && useNativeEngine()) return true;
  return getSpeechRecognition() !== null;
}

export const IDLE_STATES = new Set(["idle", "disconnected", "error"]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * "Hi LILO" activation.
 *
 * On match: continues the active conversation and connects (straight into
 * listening). Only a conversation nobody has spoken in yet gets the greeting.
 *
 * Only runs while idle — once a session is live the microphone belongs to the
 * realtime transport.
 */
export function useWakeWord(): void {
  const enabled = usePreferencesStore((s) => s.wakeWord);
  const phrase = usePreferencesStore((s) => s.wakePhrase);
  const greeting = usePreferencesStore(effectiveGreeting);
  const connectionState = useSessionStore((s) => s.connectionState);
  const plugins = usePluginsStore((s) => s.plugins);

  const greetingRef = useRef(greeting);
  greetingRef.current = greeting;
  const phraseRef = useRef(phrase);
  phraseRef.current = phrase;
  const triggeringRef = useRef(false);

  const native = useNativeEngine();
  const idle = IDLE_STATES.has(connectionState);
  const localVoiceRef = useRef<LocalVoiceController | null>(null);
  const [localTranscriptReady, setLocalTranscriptReady] = useState(!native);
  if (!localVoiceRef.current) {
    localVoiceRef.current = new LocalVoiceController(
      async (transcript) => {
        const session = useSessionStore.getState();
        if (!usePreferencesStore.getState().wakeWord || !IDLE_STATES.has(session.connectionState)) return;
        try {
          await session.initCommandRouting();
          if (!usePreferencesStore.getState().wakeWord || !IDLE_STATES.has(useSessionStore.getState().connectionState)) return;
          await handleLocalUtterance(transcript);
        } catch (error) {
          logError("local-voice", error);
        }
      },
      () => usePreferencesStore.getState().wakeWord && IDLE_STATES.has(useSessionStore.getState().connectionState),
    );
  }

  const trigger = useCallback(async () => {
    const store = useSessionStore.getState();
    // Ignore stray wake events while a call is already live or connecting.
    if (!IDLE_STATES.has(store.connectionState)) return;
    if (triggeringRef.current) return;
    triggeringRef.current = true;
    log("wake", "triggered → continue conversation + connect");
    store.continueConversation();
    try {
      // The store sends the greeting after the language rule; sending it from
      // here raced ahead of that rule.
      await store.connect({ greeting: greetingRef.current });
    } catch (error) {
      logError("wake", error);
    } finally {
      triggeringRef.current = false;
    }
  }, []);

  // --- native engine (macOS) ---------------------------------------------
  useEffect(() => {
    if (!native) return;
    const active = enabled && idle && localTranscriptReady;
    log(
      "wake",
      `native engine ${active ? "start" : "stop"} (phrase="${phraseRef.current}", enabled=${enabled}, idle=${idle})`,
    );
    void setWakeWatch(active, phraseRef.current).catch((error) => {
      logError("wake", error);
    });
    // No per-change cleanup here: calling setWakeWatch(false) on every
    // dependency change races with the next setWakeWatch(true), which can leave
    // the listener disabled after a call ends. Disable only on unmount.
  }, [native, enabled, idle, phrase, plugins, localTranscriptReady]);

  // Local command speech shares native capture and only runs while the
  // provider is idle. Listener setup is race-safe across unmounts.
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let off: (() => void) | undefined;
    setLocalTranscriptReady(false);
    void onLocalVoiceTranscript((transcript) => {
      const controller = localVoiceRef.current;
      if (!usePreferencesStore.getState().wakeWord || !IDLE_STATES.has(useSessionStore.getState().connectionState)) {
        controller?.cancel();
        return;
      }
      controller?.push(transcript);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else {
        off = unlisten;
        setLocalTranscriptReady(true);
      }
    }).catch((error) => logError("local-voice", error));
    return () => {
      disposed = true;
      off?.();
      setLocalTranscriptReady(false);
      localVoiceRef.current?.cancel();
    };
  }, [native, enabled, connectionState]);

  useEffect(() => () => localVoiceRef.current?.cancel(), []);

  useEffect(() => {
    if (!native) return;
    return () => {
      void setWakeWatch(false, phraseRef.current).catch(() => {});
    };
  }, [native]);

  useEffect(() => {
    if (!native) return;
    let off: (() => void) | undefined;
    void onWakeWord(() => {
      if (!usePreferencesStore.getState().wakeWord) return;
      log("wake", "native wake-word event received");
      void trigger();
    }).then((unlisten) => {
      off = unlisten;
    });
    return () => off?.();
  }, [native, trigger]);

  // The appliance's physical button (and the satellite test client) asks for a
  // session over the same seam; a button on a box with no UI must behave like
  // the wake word, or the two paths drift apart.
  useEffect(() => {
    let off: (() => void) | undefined;
    void onSatelliteActivate(() => {
      log("wake", "activation requested (button/satellite)");
      void trigger();
    }).then((unlisten) => {
      off = unlisten;
    });
    return () => off?.();
  }, [trigger]);

  // A listener that cannot work must say so. Without this the engine retries
  // silently forever and the wake word just looks broken.
  useEffect(() => {
    let off: (() => void) | undefined;
    void onWakeBlocked((block) => {
      if (block) log("wake", `blocked: ${block.reason}`);
      useWakeStore.getState().setBlocked(block);
    }).then((unlisten) => {
      off = unlisten;
    });
    return () => off?.();
  }, []);

  // --- browser engine (Windows/WebView2, Chromium) -----------------------
  useEffect(() => {
    if (native) return;
    if (!enabled) return;
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;
    if (!idle) return;

    log("wake", "browser recognizer armed");

    let stopped = false;
    let recognition: SpeechRecognitionLike | null = null;
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    let browserTurn = 0;

    const fire = () => {
      if (stopped) return;
      stopped = true;
      log("wake", "browser wake phrase detected");
      if (restartTimer) clearTimeout(restartTimer);
      try {
        recognition?.abort();
      } catch {
        /* ignore */
      }
      recognition = null;
      void trigger();
    };

    const start = () => {
      if (stopped) return;
      const instance = new Ctor();
      recognition = instance;
      instance.continuous = true;
      instance.interimResults = true;
      instance.maxAlternatives = 1;
      instance.lang = navigator.language || "en-US";
      instance.onresult = (event) => {
        // A transcript proves the service is answering; clear a stale block.
        useWakeStore.getState().setBlocked(null);
        const target = normalize(phraseRef.current);
        if (!target) return;
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const raw = result?.[0]?.transcript ?? "";
          const text = normalize(raw);
          if (result?.isFinal && text && !text.includes(target)) {
            localVoiceRef.current?.push({
              version: 1,
              turnId: `browser-${Date.now()}-${++browserTurn}`,
              text: raw,
              isFinal: true,
            });
          }
          if (text.includes(target)) {
            fire();
            return;
          }
        }
      };
      instance.onerror = (event: unknown) => {
        // Most errors are transient and `onend` restarts us. Permission errors
        // are not: they need the user, so surface them the same way the native
        // engine surfaces a blocked recognizer.
        const code = (event as { error?: string } | null)?.error ?? "";
        if (
          code === "not-allowed" ||
          code === "service-not-allowed" ||
          code === "network" ||
          code === "language-not-supported"
        ) {
          useWakeStore.getState().setBlocked({ reason: code });
        }
      };
      instance.onend = () => {
        if (stopped) return;
        restartTimer = setTimeout(start, 350);
      };
      try {
        instance.start();
      } catch {
        /* start() throws if already running */
      }
    };

    start();

    return () => {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      try {
        recognition?.abort();
      } catch {
        /* ignore */
      }
      recognition = null;
    };
  }, [native, enabled, connectionState, idle, trigger]);
}
