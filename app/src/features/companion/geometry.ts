/**
 * The companion window's layout, logical px. The window size is mirrored from
 * `src-tauri/src/shell.rs`; the positions below are what `companion.css` draws.
 */

export const WINDOW_W = 820;
/** Room above the mascot's 330px box, where a picture thought grows. */
export const LIFT = 170;
export const WINDOW_H = 330 + LIFT;

/** The mascot body's centre and radius inside the window. */
export const BODY = { x: 410, y: LIFT + 159, r: 88.5 } as const;

/** Bubble width limit plus the gap to the body: the room one side needs. */
export const BUBBLE_ROOM = 400;

export type Side = "left" | "right";

/** Free space from the mascot's centre to each edge of its screen. */
export interface Space {
  left: number;
  right: number;
}

/**
 * The bubble goes right when it fits there, left when only that side fits,
 * and to the roomier side when neither does.
 */
export function bubbleSide(space: Space | null): Side {
  if (!space) return "right";
  if (space.right >= BUBBLE_ROOM) return "right";
  if (space.left >= BUBBLE_ROOM) return "left";
  return space.right >= space.left ? "right" : "left";
}

/** How long a finished reply stays readable, by its length. */
export function holdMs(text: string): number {
  return Math.min(9_000, Math.max(3_000, 2_200 + 35 * text.length));
}
