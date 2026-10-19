/**
 * Where the pointer is, in the character's own space.
 *
 * The model reads this inside its animation loop — never through React state,
 * for the same reason audio does: a moving mouse must not re-render the app.
 * The gaze is released a couple of seconds after the pointer stops, so LILO
 * goes back to its own idle wandering instead of staring at a parked cursor.
 */
export interface GazeTarget {
  /** -1 (left edge) … 1 (right edge). */
  x: number;
  /** -1 (top edge) … 1 (bottom edge). */
  y: number;
}

/** How long the gaze survives without a new move. */
const HOLD_MS = 2500;
/** Once the pointer leaves the window, LILO looks away soon after. */
const LEAVE_MS = 450;
/** Smallest half-extent used for normalization, in CSS pixels: inside a small
 *  stage the eyes would otherwise slam to the edge on the first pixel. */
const MIN_HALF = 160;
/** How quickly the eyes approach full turn as the pointer moves out. */
const AIM_GAIN = 1.3;
/** Pointer distance (in stage half-extents) that reaches the full turn. */
const AIM_EDGE = 1.6;

let current: GazeTarget | null = null;
let movedAt = 0;

/**
 * Where the eyes aim for a pointer offset (unclamped, stage half-extents = 1).
 *
 * The direction is kept and only the distance is eased: eyes turn by an angle,
 * so a far pointer saturates softly instead of hitting a square wall, and a
 * pointer in a corner is no farther than one at the side.
 */
export function aimGaze(dx: number, dy: number): GazeTarget {
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: 0, y: 0 };
  const eased = Math.tanh(distance * AIM_GAIN) / Math.tanh(AIM_GAIN * AIM_EDGE);
  const reach = Math.min(1, eased);
  return { x: (dx / distance) * reach, y: (dy / distance) * reach };
}

/** The gaze to paint, or `null` after the pointer has been still for a while. */
export function pointerGaze(now = performance.now()): GazeTarget | null {
  if (!current || now - movedAt > HOLD_MS) return null;
  return current;
}

/** Follow the pointer anywhere in the window, relative to `target`. */
export function watchPointerGaze(target: Element): () => void {
  const onMove = (event: PointerEvent) => {
    const box = target.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const halfW = Math.max(box.width / 2, MIN_HALF);
    const halfH = Math.max(box.height / 2, MIN_HALF);
    current = aimGaze(
      (event.clientX - (box.left + box.width / 2)) / halfW,
      (event.clientY - (box.top + box.height / 2)) / halfH,
    );
    movedAt = performance.now();
  };
  const onLeave = (event: MouseEvent) => {
    if (event.relatedTarget) return;
    movedAt = Math.min(movedAt, performance.now() - HOLD_MS + LEAVE_MS);
  };
  window.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("mouseout", onLeave);
  return () => {
    window.removeEventListener("pointermove", onMove);
    document.removeEventListener("mouseout", onLeave);
    current = null;
  };
}
