import { isTauri, mediaLevels } from "./gateway";
import { log } from "./log";
import { watchWindowVisibility } from "../shared/lib/visibleRaf";

/**
 * Live loudness of the music mpv plays, polled while a track is playing.
 *
 * mpv is outside the WebView's audio graph, so the visualizers cannot analyse
 * it themselves; the host reads mpv's own loudness stats instead. One request
 * at a time, so a slow IPC round trip never piles up.
 */
export interface MusicLevels {
  level: number;
  low: number;
  high: number;
}

const POLL_MS = 50;
/** An older reading is not "now" any more. */
const STALE_MS = 400;
/** Eight seconds of misses is a real problem; opening a stream takes a few. */
const MISSES_BEFORE_WARNING = 160;

let latest: { levels: MusicLevels; at: number } | null = null;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let misses = 0;
let announcedLive = false;
let visible = true;
let generation = 0;
let unwatch: (() => void) | null = null;

async function tick(): Promise<void> {
  if (!running || !visible) return;
  const requestGeneration = generation;
  try {
    const levels = await mediaLevels();
    if (requestGeneration !== generation) return;
    latest = levels ? { levels, at: performance.now() } : null;
    if (levels) {
      misses = 0;
      if (!announcedLive) {
        announcedLive = true;
        log("music", `levels live (level=${levels.level.toFixed(2)})`);
      }
    } else if (++misses === MISSES_BEFORE_WARNING) {
      // The players own this state; say it once, so a silent face next to a
      // playing track is never a mystery.
      log("music", "no levels from the player for 2s while a track is loaded");
    }
  } catch (error) {
    if (requestGeneration !== generation) return;
    latest = null;
    if (++misses === MISSES_BEFORE_WARNING) {
      log("music", `levels request failed: ${String(error)}`);
    }
  }
  if (running && visible && requestGeneration === generation) {
    timer = setTimeout(() => void tick(), POLL_MS);
  }
}

export function startMusicLevels(): void {
  if (running || !isTauri()) return;
  running = true;
  generation += 1;
  misses = 0;
  announcedLive = false;
  log("music", "levels poller start");
  unwatch = watchWindowVisibility((nextVisible) => {
    visible = nextVisible;
    generation += 1;
    if (timer) clearTimeout(timer);
    timer = null;
    latest = null;
    if (visible) void tick();
  });
}

export function stopMusicLevels(): void {
  if (!running) return;
  running = false;
  generation += 1;
  unwatch?.();
  unwatch = null;
  if (timer) clearTimeout(timer);
  timer = null;
  latest = null;
  log("music", "levels poller stop");
}

/** The current reading, or `null` when there is no fresh one. */
export function musicLevels(): MusicLevels | null {
  if (!latest || performance.now() - latest.at > STALE_MS) return null;
  return latest.levels;
}
