/**
 * Now-playing state for the on-screen player.
 *
 * Separate from `sessionStore` because the player must work with no voice
 * session at all (music started by voice, then the call ended) and because
 * `sessionStore` subscribes to this to gate the microphone — importing it the
 * other way would be a cycle.
 *
 * Polls instead of pushing: the Rust side owns the player, and polling a cheap
 * async command is simpler than threading an event through every playback
 * mutation. The interval tightens only while something is actually playing.
 */

import { create } from "zustand";

import { hasHost, mediaReport, runTool } from "../lib/gateway";
import type { NowPlaying } from "../types";

const IDLE_POLL_MS = 4_000;
const ACTIVE_POLL_MS = 1_000;

interface MediaStore {
  nowPlaying: NowPlaying | null;
  playerFound: boolean;
  /** Tool currently in flight, so the transport can show a busy state. */
  busy: string | null;
  refresh: () => Promise<void>;
  run: (name: string, args?: Record<string, unknown>) => Promise<void>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export const useMediaStore = create<MediaStore>((set, get) => ({
  nowPlaying: null,
  playerFound: false,
  busy: null,

  refresh: async () => {
    if (!hasHost() || inFlight) return;
    inFlight = true;
    try {
      const report = await mediaReport();
      set({ nowPlaying: report.nowPlaying, playerFound: report.playerFound });
    } catch {
      // A transient failure must not erase the controls; the next tick retries.
    } finally {
      inFlight = false;
    }
  },

  run: async (name, args = {}) => {
    set({ busy: name });
    try {
      await runTool(name, args);
      await get().refresh();
    } finally {
      set({ busy: null });
    }
  },
}));

/** True when a track is loaded (paused or not). */
export function isPlaying(nowPlaying: NowPlaying | null): boolean {
  return (nowPlaying?.queueLength ?? 0) > 0;
}

/** Start the adaptive poller. Idempotent; safe to call on every mount. */
export function startMediaPolling({ pauseWhenHidden = false }: { pauseWhenHidden?: boolean } = {}): void {
  if (timer !== null) return;
  const tick = () => {
    if (!pauseWhenHidden || !document.hidden) void useMediaStore.getState().refresh();
    const next = isPlaying(useMediaStore.getState().nowPlaying)
      ? ACTIVE_POLL_MS
      : IDLE_POLL_MS;
    if (timer !== null) clearInterval(timer);
    timer = setInterval(tick, next);
  };
  tick();
}

export function stopMediaPolling(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}
