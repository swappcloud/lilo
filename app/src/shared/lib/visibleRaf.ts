/**
 * An animation loop that pauses with the window and caps its frame rate.
 *
 * Two costs made a laptop fan spin for a window nobody was looking at:
 *   * WebView2 does not set `document.hidden` when the host window is
 *     minimized, so a plain visibility check never fired — the Tauri window
 *     events are what actually detect it here;
 *   * the character, the scene and the orb repainted at the full frame rate
 *     forever, which measured ~50% of a core on the desktop. Thirty frames is
 *     plenty for idle motion, and an active phase can ask for sixty.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";

interface LoopOptions {
  /** Frames per second to draw; rAF keeps its own cadence. */
  fps?: number;
}

const DEFAULT_FPS = 30;

/** Whether the whole window is hidden or minimized (not just the document). */
let windowHidden = typeof document !== "undefined" ? document.hidden : false;
const hiddenListeners = new Set<() => void>();
let watchingWindow = false;
let nativeHidden = false;
let refreshing = false;

function setWindowHidden(hidden: boolean) {
  if (hidden === windowHidden) return;
  windowHidden = hidden;
  // CSS animations are composited on the GPU and keep ticking with no rAF at
  // all: a minimized LILO kept a fan on through the orb's pulse and the idle
  // keyframes until the stylesheet was told to pause them too.
  if (typeof document !== "undefined") {
    if (hidden) document.documentElement.dataset.windowHidden = "true";
    else delete document.documentElement.dataset.windowHidden;
  }
  for (const listener of hiddenListeners) listener();
}

async function refreshWindowHidden() {
  if (refreshing) return;
  refreshing = true;
  try {
    const window = getCurrentWindow();
    const [minimized, visible] = await Promise.allSettled([
      window.isMinimized(), window.isVisible(),
    ]);
    nativeHidden = (minimized.status === "fulfilled" && minimized.value) ||
      (visible.status === "fulfilled" && !visible.value);
  } catch {
    // A plain browser, or IPC not up yet: the document state is all we have.
  } finally {
    refreshing = false;
  }
  setWindowHidden(document.hidden || nativeHidden);
}

let watchCount = 0;
let poll: number | undefined;

function watchWindow() {
  if (watchingWindow) return;
  watchingWindow = true;
  document.addEventListener("visibilitychange", () => {
    // The document state is synchronous and always right in a browser; the
    // window check below only adds what WebView2 forgets to report.
    setWindowHidden(document.hidden || nativeHidden);
    void refreshWindowHidden();
  });
  void Promise.resolve()
    .then(() => {
      const window = getCurrentWindow();
      // Each registration on its own: one missing method must not take the
      // other listener down with it.
      try {
        void window.onFocusChanged(() => void refreshWindowHidden());
      } catch {
        /* not fatal: the poll below still notices */
      }
      try {
        void window.onResized(() => void refreshWindowHidden());
      } catch {
        /* not fatal: the poll below still notices */
      }
    })
    .catch(() => {
      /* not Tauri; the visibility listener is enough */
    });
  void refreshWindowHidden();
}

/// Keeps the window state fresh while at least one loop is running. The
/// window events miss a plain minimize on WebView2, and a second of latency
/// costs nothing next to a paused animation.
function acquireWindowWatch() {
  watchCount += 1;
  watchWindow();
  if (poll === undefined) {
    poll = window.setInterval(() => void refreshWindowHidden(), 1000);
  }
}

function releaseWindowWatch() {
  watchCount -= 1;
  if (watchCount <= 0 && poll !== undefined) {
    window.clearInterval(poll);
    poll = undefined;
  }
}

/** Share one native visibility watch between animation and visual audio data. */
export function watchWindowVisibility(listener: (visible: boolean) => void): () => void {
  const notify = () => listener(!windowHidden);
  hiddenListeners.add(notify);
  acquireWindowWatch();
  notify();
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    hiddenListeners.delete(notify);
    releaseWindowWatch();
  };
}

/**
 * Runs `frame` while the window is visible, at most `fps` times a second.
 *
 * `frame` returns whether the loop should continue (a renderer with nothing
 * left to draw returns false and waits for its next state change). The
 * returned function stops the loop for good.
 */
export function runVisibleAnimationLoop(
  frame: (now: number) => boolean,
  options: LoopOptions = {},
): () => void {
  const fps = options.fps ?? DEFAULT_FPS;
  const step = 1000 / fps;
  let raf = 0;
  let running = false;
  let finished = false;
  // Draw the first frame immediately, then keep to the cadence.
  let lastDraw = Number.NEGATIVE_INFINITY;

  const loop = (now: number) => {
    raf = 0;
    // A frame may arrive early because rAF runs at the display rate; drawing
    // only on the cadence keeps the GPU (and the fan) quiet. A millisecond of
    // slack stops a 60 Hz display from being read as 59.9 and skipping.
    if (now - lastDraw >= step - 1) {
      lastDraw = now;
      if (!frame(now)) {
        running = false;
        finished = true;
        unsubscribe();
        return;
      }
    }
    raf = requestAnimationFrame(loop);
  };

  const start = () => {
    if (running || windowHidden || finished) return;
    running = true;
    raf = requestAnimationFrame(loop);
  };

  const stop = () => {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const unsubscribe = watchWindowVisibility((visible) => {
    if (visible) start();
    else stop();
  });

  return () => {
    unsubscribe();
    stop();
  };
}
