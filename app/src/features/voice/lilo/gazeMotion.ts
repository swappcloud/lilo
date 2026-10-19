/**
 * How LILO's eyes get where they look.
 *
 * Eyes do not glide after a target. They jump — a saccade: a few tens of
 * milliseconds, fast in the middle, soft at both ends — then hold still, and
 * only follow smoothly when the target itself moves slowly. A big jump lands a
 * little short and a small correction finishes it; a fixation is never quite
 * frozen, it twitches (microsaccades). The head follows the eyes much later.
 * Exponential chasing, which the model used before, does none of this and
 * reads as rubbery.
 *
 * Units are the model's SVG units; time is milliseconds (`performance.now()`).
 */

/** Below this error the eyes pursue instead of jumping. */
const SACCADE_MIN = 3;
/** Reaction time before a jump: instant jumps look mechanical. */
const LATENCY_MS = 55;
/** After a jump the eyes hold a moment before the next one. */
const REFRACTORY_MS = 110;
const REFRACTORY_JITTER_MS = 90;
/** Saccade duration grows with its amplitude (the "main sequence"). */
const DURATION_BASE_MS = 28;
const DURATION_PER_UNIT_MS = 2.1;
/** Large jumps land short by this fraction; a corrective jump follows. */
const UNDERSHOOT = 0.9;
const UNDERSHOOT_FROM = 10;
/** Smooth pursuit stiffness (rad/s, critically damped). */
const PURSUIT_OMEGA = 16;
/** Head stiffness: the face turns well after the eyes arrive. */
const HEAD_OMEGA = 4.2;
/** Microsaccades while fixating. */
const MICRO_EVERY_MS = 900;
const MICRO_JITTER_MS = 1300;
const MICRO_AMPLITUDE = 1.1;
/** Jumps at least this large sometimes come with a blink. */
const BLINK_FROM = 14;
const BLINK_CHANCE = 0.3;

interface Saccade {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  start: number;
  duration: number;
}

/** Minimum-jerk profile: zero velocity and acceleration at both ends. */
export function minimumJerk(u: number): number {
  const t = Math.max(0, Math.min(1, u));
  return t * t * t * (10 - 15 * t + 6 * t * t);
}

export function saccadeDuration(amplitude: number): number {
  return DURATION_BASE_MS + DURATION_PER_UNIT_MS * amplitude;
}

export class GazeMotion {
  /** Eye offset. */
  x = 0;
  y = 0;
  /** Head (face) offset, trailing the eyes. */
  headX = 0;
  headY = 0;
  private vx = 0;
  private vy = 0;
  private headV = 0;
  private headVy = 0;
  private saccade: Saccade | null = null;
  private readyAt = 0;
  private offTargetSince = -1;
  private microAt = 0;
  private last = 0;

  constructor(private readonly random: () => number = Math.random) {}

  /**
   * Advance to `now` towards the target. Returns `true` when this step
   * launched a jump large enough to blink with.
   */
  step(now: number, targetX: number, targetY: number): boolean {
    const dt = this.last ? Math.min(now - this.last, 50) / 1000 : 1 / 60;
    this.last = now;
    let blink = false;

    if (this.saccade) {
      const s = this.saccade;
      const k = minimumJerk((now - s.start) / s.duration);
      this.x = s.fromX + (s.toX - s.fromX) * k;
      this.y = s.fromY + (s.toY - s.fromY) * k;
      if (now - s.start >= s.duration) {
        this.saccade = null;
        this.vx = 0;
        this.vy = 0;
        this.readyAt = now + REFRACTORY_MS + this.random() * REFRACTORY_JITTER_MS;
        this.microAt = now + MICRO_EVERY_MS + this.random() * MICRO_JITTER_MS;
      }
    } else {
      const ex = targetX - this.x;
      const ey = targetY - this.y;
      const error = Math.hypot(ex, ey);
      if (error > SACCADE_MIN) {
        if (this.offTargetSince < 0) this.offTargetSince = now;
      } else {
        this.offTargetSince = -1;
      }

      if (
        this.offTargetSince >= 0 &&
        now - this.offTargetSince >= LATENCY_MS &&
        now >= this.readyAt
      ) {
        const reach = error > UNDERSHOOT_FROM ? UNDERSHOOT : 1;
        blink = error >= BLINK_FROM && this.random() < BLINK_CHANCE;
        this.launch(now, this.x + ex * reach, this.y + ey * reach, error * reach);
        this.offTargetSince = -1;
      } else if (error <= SACCADE_MIN && now >= this.microAt && now >= this.readyAt) {
        const angle = this.random() * Math.PI * 2;
        const size = MICRO_AMPLITUDE * (0.4 + 0.6 * this.random());
        this.launch(
          now,
          targetX + Math.cos(angle) * size,
          targetY + Math.sin(angle) * size * 0.6,
          size,
        );
      } else if (this.offTargetSince >= 0) {
        // Too far to pursue: hold still until the jump (reaction time or the
        // pause after the last one) instead of sliding towards it.
        this.vx = 0;
        this.vy = 0;
      } else {
        // Smooth pursuit: a critically damped spring, framerate independent.
        const w = PURSUIT_OMEGA;
        this.vx += (w * w * ex - 2 * w * this.vx) * dt;
        this.vy += (w * w * ey - 2 * w * this.vy) * dt;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
      }
    }

    const hw = HEAD_OMEGA;
    this.headV += (hw * hw * (this.x - this.headX) - 2 * hw * this.headV) * dt;
    this.headX += this.headV * dt;
    this.headVy += (hw * hw * (this.y - this.headY) - 2 * hw * this.headVy) * dt;
    this.headY += this.headVy * dt;
    return blink;
  }

  /** Jump straight to a pose, with no motion. */
  settle(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.headX = x;
    this.headY = y;
    this.headVy = 0;
    this.vx = 0;
    this.vy = 0;
    this.headV = 0;
    this.saccade = null;
    this.offTargetSince = -1;
  }

  private launch(now: number, toX: number, toY: number, amplitude: number): void {
    this.saccade = {
      fromX: this.x,
      fromY: this.y,
      toX,
      toY,
      start: now,
      duration: saccadeDuration(amplitude),
    };
  }
}
