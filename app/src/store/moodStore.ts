import { create } from "zustand";

import { onMood } from "../lib/gateway";
import type { MoodKind } from "../types";

const KINDS: ReadonlySet<MoodKind> = new Set(["happy", "sad", "angry", "surprised"]);

/** How long a shown expression holds before fading back to neutral on its own. */
const HOLD_MS = 5_000;
/** A reaction read from the conversation is briefer than one asked for. */
const CONTEXT_HOLD_MS = 3_500;

interface MoodStore {
  mood: MoodKind | null;
  setMood: (mood: MoodKind | null) => void;
}

export const useMoodStore = create<MoodStore>((set) => ({
  mood: null,
  setMood: (mood) => set({ mood }),
}));

/** Plugin output is untrusted: anything outside the vocabulary is ignored. */
function toMood(value: unknown): MoodKind | "neutral" | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "neutral") return "neutral";
  return typeof kind === "string" && KINDS.has(kind as MoodKind) ? (kind as MoodKind) : null;
}

let hold: ReturnType<typeof setTimeout> | undefined;
/** Until when an asked-for expression outranks the conversation's. */
let askedUntil = 0;

/**
 * Shows an expression, then fades it back to neutral. `asked` is a command or
 * a plugin naming one; `context` is what the conversation reads as
 * (`moodContext`), which never overrides an asked one still on screen.
 */
export function showMood(kind: MoodKind | "neutral", origin: "asked" | "context"): void {
  const now = Date.now();
  if (origin === "context" && now < askedUntil) return;
  clearTimeout(hold);
  if (kind === "neutral") {
    askedUntil = 0;
    useMoodStore.getState().setMood(null);
    return;
  }
  const ms = origin === "asked" ? HOLD_MS : CONTEXT_HOLD_MS;
  if (origin === "asked") askedUntil = now + ms;
  useMoodStore.getState().setMood(kind);
  hold = setTimeout(() => useMoodStore.getState().setMood(null), ms);
}

/**
 * Start listening for `lilo://mood`. An expression fades back to neutral on
 * its own after a hold, so a plugin only ever says what to show, never for
 * how long. Returns the cleanup.
 */
export function startMood(): () => void {
  let stopped = false;
  let unlisten: (() => void) | undefined;
  void onMood((payload) => {
    const kind = toMood(payload);
    if (kind !== null) showMood(kind, "asked");
  }).then((off) => {
    if (stopped) off();
    else unlisten = off;
  });
  return () => {
    stopped = true;
    clearTimeout(hold);
    askedUntil = 0;
    unlisten?.();
  };
}
