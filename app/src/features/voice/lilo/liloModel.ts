import { GazeMotion } from "./gazeMotion";
import type { VoicePhase } from "../orbRenderer";
import type { MoodKind } from "../../../types";

/**
 * The LILO character: the brand mark come alive.
 *
 * At rest on intro time 0 it draws exactly the vector logo — a speech bubble
 * split in ink and paper with two waveforms. The intro beats the waveforms
 * twice, then morphs them into an eye and a mouth, pops the second eye and
 * blinks. After that it idles, listens (waveform mouth), thinks (squinting,
 * looking up) and speaks (lip-sync from the real voice level).
 *
 * Pure geometry, no DOM: a renderer copies `frame()` into SVG attributes. Kept
 * out of React so 60 fps never means 60 re-renders.
 */

export interface LiloInput {
  phase: VoicePhase;
  /**
   * Live voice loudness 0..1, or `null` to synthesize one (speaking without an
   * analyser still moves the mouth).
   */
  level: number | null;
  /** Low-band energy 0..1 (jaw / body wobble). Defaults to `level`. */
  low?: number | null;
  /** High-band energy 0..1 (vowel shape / fine ripple). */
  high?: number | null;
  /** Local music is playing: LILO sways to it. */
  music: boolean;
  /** Live loudness of that music, when the player reports it. */
  musicLevels?: { level: number; low: number; high: number } | null;
  /**
   * Pointer position in the character's space (-1..1, centre 0), or `null`
   * when the pointer has been still: LILO watches the mouse, then lets go.
   */
  gaze?: { x: number; y: number } | null;
  /** A tool asked for an expression; `null`/`undefined` is the resting face. */
  mood?: MoodKind | null;
}

export interface LiloFrame {
  bodyD: string;
  darkD: string;
  tilt: string;
  shadowY: number;
  shadowRx: number;
  shadowOpacity: number;
  eyeLeft: { cx: number; cy: number; rx: number; ry: number };
  eyeRight: { cx: number; cy: number; rx: number; ry: number };
  mouthD: string;
  mouthOpacity: number;
  waveD: string;
  waveOpacity: number;
  upperWaveD: string;
  upperWaveOpacity: number;
  lowerWaveD: string;
  lowerWaveOpacity: number;
  browLeftD: string;
  browRightD: string;
  browOpacity: number;
}

/** Intro seconds: waveforms have finished becoming a face. */
export const INTRO_FACE_AT = 2.35;
/** Intro seconds: fully alive, phases take over. */
export const INTRO_DONE_AT = 3.2;
/** While held, the intro loops its heartbeat instead of becoming a face. */
const HOLD_LOOP_END = 1.5;
const HOLD_LOOP_START = 0.45;

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

/** Fixed samples keep the same curves without rebuilding their geometry. */
function arcSamples(from: number, to: number) {
  const degrees: number[] = [];
  for (let d = from; d < to; d += 3) degrees.push(d);
  degrees.push(to);
  return degrees.map((deg) => ({ deg, sin: Math.sin(deg * D2R), cos: Math.cos(deg * D2R) }));
}

const BODY_ARCS = [arcSamples(70, 216), arcSamples(251, 391)];
const SPLIT_SAMPLES = Array.from({ length: 73 }, (_, index) => {
  const halfIndex = index <= 36 ? 0 : 1;
  const j = halfIndex === 0 ? index : index - 36;
  const u = halfIndex * 0.5 + (1 - Math.cos((j / 36) * Math.PI)) / 4;
  const q = u < 0.5 ? u * 2 : (u - 0.5) * 2;
  return {
    u,
    curve: Math.sqrt(Math.max(0, 1 - (2 * q - 1) * (2 * q - 1))),
    sin: Math.sin(u * Math.PI),
  };
});
const WAVE_SAMPLES = Array.from({ length: 26 }, (_, index) => {
  const x = -32 + index * 2.5;
  return { x, envelope: Math.exp(-((x / 14) ** 2)) };
});

/** Eye travel, in SVG units, when the pointer sits at the edge of the stage. */
const GAZE_X = 22;
/** The body is not symmetric (the tail is on the left), so the same travel to
 *  the right leaves the eyes short of the edge and reading as "the middle". */
const GAZE_X_RIGHT = 36;
const gazeTravelX = (x: number) => x * (x > 0 ? GAZE_X_RIGHT : GAZE_X);
/** Vertical travel. Looking down reads less than up behind the lids. */
const GAZE_Y_UP = 20;
const GAZE_Y_DOWN = 18;
const gazeTravelY = (y: number) => y * (y < 0 ? GAZE_Y_UP : GAZE_Y_DOWN);
/** How much of the gaze the whole face (the ink/paper divide) takes: the eyes
 *  lead a little, the head turns — which is what makes following look alive. */
const GAZE_DRIFT = 0.8;

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const smoothstep = (a: number, b: number, x: number) => {
  const u = clamp((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};
/** Ease-out with overshoot, 0 before start. */
const back = (x: number) => {
  const u = clamp(x);
  if (u <= 0) return 0;
  const c = 1.9;
  return 1 + (c + 1) * (u - 1) ** 3 + c * (u - 1) ** 2;
};
const gauss = (x: number, m: number, w: number) => {
  const d = (x - m) / w;
  return Math.exp(-d * d);
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const pt = (q: [number, number]) => `${r1(q[0])},${r1(q[1])}`;

/** The logo's heartbeat glyph, normalized to a half width and amplitude. */
const WAVE_SHAPE: ReadonlyArray<[number, number]> = [
  [-1, 0], [-0.62, 0], [-0.5, -0.18], [-0.38, 0.22], [-0.26, -0.5], [-0.13, 0.62],
  [0, -1], [0.13, 0.9], [0.26, -0.55], [0.38, 0.3], [0.5, -0.16], [0.62, 0], [1, 0],
];

function logoWave(x0: number, y0: number, hw: number, amp: number): string {
  return `M${WAVE_SHAPE.map(([x, y]) => `${r1(x0 + x * hw)},${r1(y0 + y * amp)}`).join(" L")}`;
}

export interface LiloModelOptions {
  /** Start at the logo and play the intro. Otherwise start alive. */
  intro?: boolean;
  random?: () => number;
}

export class LiloModel {
  private readonly bodyPoints = BODY_ARCS.map((arc) => arc.map((): [number, number] => [0, 0]));
  private readonly splitPoints = SPLIT_SAMPLES.map((): [number, number] => [0, 0]);
  private readonly random: () => number;
  private started = false;
  private last = 0;
  private t = 0;
  private lv = 0;
  private lo = 0;
  private hi = 0;
  private vow = 0.5;
  private vowT = 0.5;
  private vowNext = 0;
  private think = 0;
  private listen = 0;
  private speak = 0;
  private music = 0;
  private tilt = 0;
  /** Smoothed 0..1 per expression, so a change eases in/out instead of cutting. */
  private moodHappy = 0;
  private moodSad = 0;
  private moodAngry = 0;
  private moodSurprised = 0;
  /** Saccades, pursuit and the head trailing the eyes. */
  private readonly eyes: GazeMotion;
  /** Face-turn drift: the divide, a beat behind the eyes. */
  private gd = 0;
  /** Vertical head follow: the face nods after the eyes. */
  private gdy = 0;
  private gx = 0;
  private gy = 0;
  private gxT = 0;
  private gyT = 0;
  private nextGaze = 0;
  private bf = 1;
  private blinkStart = -1;
  private nextBlink = 0;
  private dbl = false;
  private sylStart = 0;
  private sylEnd = 0;
  private sylAmp = 0;
  /** Intro clock in seconds; `INTRO_DONE_AT` and beyond means alive. */
  private it: number;
  private held = false;
  private blinkForced: boolean;
  private al: number;
  private beat = 0;

  constructor(options: LiloModelOptions = {}) {
    this.random = options.random ?? Math.random;
    this.eyes = new GazeMotion(this.random);
    this.it = options.intro ? 0 : 99;
    this.al = options.intro ? 0 : 1;
    this.blinkForced = !options.intro;
  }

  /** Keep beating as the logo until `release()` (used while the app starts). */
  hold(): void {
    this.held = true;
  }

  release(): void {
    this.held = false;
  }

  /** Seconds into the intro; >= `INTRO_DONE_AT` once alive. */
  get introTime(): number {
    return this.it;
  }

  get introDone(): boolean {
    return this.it >= INTRO_DONE_AT;
  }

  /** Advance to `now` (ms, `performance.now()` clock). */
  step(now: number, input: LiloInput): void {
    if (!this.started) {
      this.started = true;
      this.nextGaze = now + 1200;
      this.nextBlink = now + 1800;
    }
    const dt = this.last ? Math.min(now - this.last, 50) : 16;
    this.last = now;
    this.t += dt / 1000;
    const t = this.t;

    if (this.it < 99) {
      this.it += dt / 1000;
      if (this.held && this.it > HOLD_LOOP_END) this.it = HOLD_LOOP_START;
      if (this.it > INTRO_DONE_AT + 1) this.it = 99;
    }
    const it = this.it;
    this.al = smoothstep(2.2, 3.2, it);
    this.beat = gauss(it, 0.85, 0.07) + 0.8 * gauss(it, 1.2, 0.07);
    const wake = gauss(it, 2.45, 0.12);

    const mode: VoicePhase = it < 3 ? "idle" : input.phase;
    // The body dances whenever a track plays — including while the assistant
    // talks, where it used to freeze; the *face* still belongs to the voice
    // then, so only `grooving` (which drives the mouth) excludes speaking.
    const swaying = input.music && mode !== "thinking" ? 1 : 0;
    const grooving = input.music && mode !== "speaking" && mode !== "thinking" ? 1 : 0;
    let tgt = 0;
    let lo = 0;
    let hi = 0;
    const level = typeof input.level === "number" ? input.level : null;
    // A live reading only counts when there is signal. The web voice path can
    // leave the phase on "speaking" after the audio stopped; taking that
    // silent reading literally closed the mouth and froze the face. Below the
    // gate the synthesized lip-sync keeps it alive.
    const live =
      level !== null && level > 0.03 && (mode === "speaking" || mode === "listening");
    const song = grooving ? input.musicLevels : null;
    if (song) {
      // The real track: the mouth wave and the body follow its loudness.
      tgt = clamp(song.level);
      lo = clamp(song.low);
      hi = clamp(song.high);
    } else if (live && !(grooving && (level ?? 0) < 0.04)) {
      tgt = clamp(level as number);
      lo = typeof input.low === "number" ? clamp(input.low) : tgt;
      hi = typeof input.high === "number" ? clamp(input.high) : tgt * 0.6;
      if (tgt > 0.08 && now > this.vowNext) {
        this.vowT = clamp(0.5 + (hi - lo) * 2 + (this.random() - 0.5) * 0.5);
        this.vowNext = now + 110 + this.random() * 120;
      }
    } else if (mode === "speaking") {
      if (now >= this.sylEnd) this.nextSyllable(now);
      const pr = clamp((now - this.sylStart) / Math.max(1, this.sylEnd - this.sylStart));
      const env = this.sylAmp > 0 ? Math.sin(Math.PI * pr) ** 0.7 : 0;
      tgt = this.sylAmp * env;
      lo = tgt;
      hi = tgt * (0.3 + 0.7 * Math.abs(Math.sin(t * 23)));
    } else if (grooving) {
      // No reading from the player yet: keep a steady beat.
      tgt = 0.16 + 0.14 * Math.abs(Math.sin(t * 3.2));
      lo = tgt * 1.2;
      hi = tgt * 0.4;
    } else if (mode === "listening") {
      tgt = 0.12 + 0.1 * Math.max(0, Math.sin(t * 5.3) * Math.sin(t * 2.1));
      lo = tgt;
      hi = tgt * 0.5;
    }
    tgt += this.beat * 0.3 + wake * 0.45;
    lo += this.beat * 0.45 + wake * 0.3;

    this.lv += (tgt - this.lv) * (tgt > this.lv ? 0.5 : 0.2);
    this.lo += (lo - this.lo) * 0.3;
    this.hi += (hi - this.hi) * 0.35;
    this.vow += (this.vowT - this.vow) * 0.25;
    this.think += ((mode === "thinking" ? 1 : 0) - this.think) * 0.06;
    this.listen += ((mode === "listening" || grooving ? 1 : 0) - this.listen) * 0.1;
    this.speak += ((mode === "speaking" ? 1 : 0) - this.speak) * 0.12;
    this.music += (swaying - this.music) * 0.05;
    this.moodHappy += ((input.mood === "happy" ? 1 : 0) - this.moodHappy) * 0.15;
    this.moodSad += ((input.mood === "sad" ? 1 : 0) - this.moodSad) * 0.15;
    this.moodAngry += ((input.mood === "angry" ? 1 : 0) - this.moodAngry) * 0.15;
    this.moodSurprised += ((input.mood === "surprised" ? 1 : 0) - this.moodSurprised) * 0.15;

    const tiltT =
      (Math.sin(t * 0.9) * 1.5 * this.speak +
        5 * this.listen * (1 - this.music) +
        Math.sin(t * 1.6) * 6 * this.music +
        (this.gd / GAZE_X) * 6 +
        (-5 + Math.sin(t * 1.2) * 2) * this.think) *
      this.al;
    this.tilt += (tiltT - this.tilt) * 0.05;

    if (now > this.nextGaze) {
      this.nextGaze = now + 1500 + this.random() * 2200;
      const range = mode === "speaking" ? 0.45 : 1;
      this.gxT = (this.random() - 0.5) * 12 * range;
      this.gyT = (this.random() - 0.5) * 8 * range;
    }
    const free = Math.max(0, 1 - this.think - this.listen);
    // A pointer in motion outranks idle wandering; the think/listen poses keep
    // their own vertical bias underneath it.
    const gaze = input.gaze;
    const gxT =
      (gaze
        ? gazeTravelX(gaze.x)
        : this.gxT * free + Math.cos(t * 1.6) * 7 * this.think) * this.al;
    const gyT =
      (gaze
        ? gazeTravelY(gaze.y) - this.listen
        : this.gyT * free +
          (-7 + Math.sin(t * 1.6) * 2) * this.think -
          1 * this.listen) * this.al;
    const blink = this.eyes.step(now, gxT, gyT);
    this.gx = this.eyes.x;
    this.gy = this.eyes.y;
    this.gdy = this.eyes.headY;
    // The face turns towards the gaze a beat after the eyes arrive.
    this.gd = this.eyes.headX;

    this.updateBlink(now, it, blink);
  }

  /**
   * Jump straight to the pose for `input`, with no motion. Used when animations
   * are off: one frame must already look right.
   */
  settle(input: LiloInput): void {
    this.it = 99;
    this.al = 1;
    this.beat = 0;
    this.blinkStart = -1;
    this.bf = 1;
    const mode = input.phase;
    this.think = mode === "thinking" ? 1 : 0;
    this.listen = mode === "listening" || (input.music && mode === "idle") ? 1 : 0;
    this.speak = mode === "speaking" ? 1 : 0;
    this.music = 0;
    this.moodHappy = input.mood === "happy" ? 1 : 0;
    this.moodSad = input.mood === "sad" ? 1 : 0;
    this.moodAngry = input.mood === "angry" ? 1 : 0;
    this.moodSurprised = input.mood === "surprised" ? 1 : 0;
    this.lv = mode === "listening" ? 0.12 : mode === "speaking" ? 0.25 : 0;
    this.lo = this.lv;
    this.hi = this.lv * 0.5;
    this.tilt = 5 * this.listen - 5 * this.think + (input.gaze ? input.gaze.x * 6 : 0);
    const gaze = input.gaze;
    this.gx = gaze ? gazeTravelX(gaze.x) : 7 * this.think;
    this.gy = gaze ? gazeTravelY(gaze.y) - this.listen : -7 * this.think - this.listen;
    this.gd = this.gx;
    this.gdy = this.gy;
    this.eyes.settle(this.gx, this.gy);
  }

  private nextSyllable(now: number): void {
    if (this.random() < 0.16) {
      this.sylAmp = 0;
      this.sylStart = now;
      this.sylEnd = now + 180 + this.random() * 420;
    } else {
      this.sylAmp = 0.45 + this.random() * 0.55;
      this.sylStart = now;
      this.sylEnd = now + 110 + this.random() * 170;
      this.vowT = this.random();
    }
  }

  private updateBlink(now: number, it: number, withSaccade = false): void {
    // A big glance often carries a blink; that is how people do it.
    if (withSaccade && it > INTRO_DONE_AT && this.blinkStart < 0) {
      this.blinkStart = now;
      this.nextBlink = Math.max(this.nextBlink, now + 1800);
    }
    if (it > 2.75 && !this.blinkForced) {
      this.blinkForced = true;
      this.blinkStart = now;
      this.dbl = true;
    }
    if (it > INTRO_DONE_AT && this.blinkStart < 0 && now > this.nextBlink) {
      this.blinkStart = now;
      this.nextBlink = now + 2200 + this.random() * 3800;
      if (this.random() < 0.2) this.dbl = true;
    }
    this.bf = 1;
    if (this.blinkStart >= 0) {
      const bp = (now - this.blinkStart) / 150;
      if (bp >= 1) {
        this.blinkStart = -1;
        if (this.dbl) {
          this.dbl = false;
          this.nextBlink = now + 110;
          if (it < INTRO_DONE_AT) this.blinkStart = now + 110;
        }
      } else if (bp > 0) {
        this.bf = 1 - Math.sin(bp * Math.PI);
      }
    }
  }

  frame(): LiloFrame {
    const { t, lv, lo, hi, al, it } = this;
    const cx = 200;
    const cy =
      196 +
      Math.sin(t * 1.3) * 2.2 * (1 - this.speak * 0.5) * al -
      lv * 5 -
      Math.abs(Math.sin(t * 3.2)) * 4 * this.music;
    const R0 = 118 * (1 + Math.sin(t * 1.6) * 0.012 * al) + lv * 4 + this.listen * 3;
    const sx = 1 - lv * 0.025;
    const sy = 1 + lv * 0.045;
    const think = this.think;

    const radiusAt = (deg: number) => {
      const a = deg * D2R;
      return (
        R0 +
        (Math.sin(a * 3 + t * 1.1) * 1.2 + Math.sin(a * 5 - t * 0.9) * 0.8) * al +
        (lo === 0 ? 0 : (Math.sin(a * 4 + t * 5) * 4 + Math.sin(a * 7 - t * 6.5) * 2.4) * lo) +
        (hi === 0 ? 0 : (Math.sin(a * 11 + t * 9) * 1.8 + Math.sin(a * 16 - t * 12) * 1) * hi) +
        (think === 0 ? 0 : Math.sin(a * 2 + t * 3.2) * 2.2 * think)
      );
    };
    const polar = (deg: number, r: number): [number, number] => {
      const a = deg * D2R;
      return [cx + Math.sin(a) * r * sx, cy - Math.cos(a) * r * sy];
    };
    // Catmull-Rom through samples every 3 degrees.
    const arc = (index: number) => {
      const ps = this.bodyPoints[index];
      const samples = BODY_ARCS[index];
      for (let i = 0; i < samples.length; i += 1) {
        const sample = samples[i];
        const radius = radiusAt(sample.deg);
        ps[i][0] = cx + sample.sin * radius * sx;
        ps[i][1] = cy - sample.cos * radius * sy;
      }
      let out = "";
      for (let i = 0; i < ps.length - 1; i += 1) {
        const p0 = ps[Math.max(0, i - 1)];
        const p1 = ps[i];
        const p2 = ps[i + 1];
        const p3 = ps[Math.min(ps.length - 1, i + 2)];
        out +=
          `C${r1(p1[0] + (p2[0] - p0[0]) / 6)},${r1(p1[1] + (p2[1] - p0[1]) / 6)} ` +
          `${r1(p2[0] - (p3[0] - p1[0]) / 6)},${r1(p2[1] - (p3[1] - p1[1]) / 6)} ${pt(p2)}`;
      }
      return out;
    };
    const wag1 = Math.sin(t * 2.1) * al;
    const wag2 = Math.sin(t * 2.1 + 1.1) * al;
    const T1 = { s: 31, tip: 41 + wag1 * 2, tr: 1.3 + wag1 * 0.03 + lv * 0.06, e: 70 };
    const T2 = { s: 216, tip: 225 + wag2 * 2, tr: 1.36 + wag2 * 0.03 + lv * 0.06, e: 251 };
    const tail = (T: typeof T1) =>
      `Q${pt(polar(T.s + (T.tip - T.s) * 0.35, R0 * 1.13))} ${pt(polar(T.tip, R0 * T.tr))}` +
      `Q${pt(polar(T.tip + (T.e - T.tip) * 0.3, R0 * 1.04))} ${pt(polar(T.e, radiusAt(T.e)))}`;
    const bodyD =
      `M${pt(polar(T1.s, radiusAt(T1.s)))}${tail(T1)}${arc(0)}` +
      `${tail(T2)}${arc(1)}Z`;

    // The ink/paper divide: an S of two half circles that pinches while thinking.
    const k = 1 - think * 0.325 * (1 - Math.cos(t * 2.4));
    const top = cy - R0 * sy;
    const h = 2 * R0 * sy;
    const half = R0 * 0.5;
    const wob = Math.sin(t * 0.8) * 2 * al;
    // The face turns with the gaze: the divide (and everything pinned to it)
    // drifts while the eyes lead it by the rest of the offset.
    let drift = this.gd * GAZE_DRIFT;
    const offsetAt = (u: number, sample?: (typeof SPLIT_SAMPLES)[number]) => {
      const q = u < 0.5 ? u * 2 : (u - 0.5) * 2;
      const c = sample?.curve ?? Math.sqrt(Math.max(0, 1 - (2 * q - 1) * (2 * q - 1)));
      return (
        (u < 0.5 ? -1 : 1) * c * half * k +
        Math.sin(u * TAU * 1.5 + t * 4) * lo * 5 +
        (sample?.sin ?? Math.sin(u * Math.PI)) * wob +
        drift
      );
    };
    const bound = (y: number) => cx + offsetAt(clamp((y - top) / h));

    const morph = smoothstep(1.55, 2.35, it);
    const popR = back((it - 1.95) / 0.4);
    const popL = back((it - 2.15) / 0.4);
    const eyeY = cy - 20 + this.gy;
    const eyeRx = 11.5 + this.listen + lv * 0.5 * al + 2 * this.moodSurprised - this.moodAngry;
    // Lids follow the gaze: a little wider looking up, lower looking down.
    const lookUp = Math.max(0, Math.min(1, -this.gy / GAZE_Y_UP));
    const lookDown = Math.max(0, Math.min(1, this.gy / GAZE_Y_DOWN));
    const eyeOpenRy =
      (14 +
        this.listen * 2.5 -
        think * 4 -
        lv * 2.5 * this.speak +
        5 * this.moodSurprised -
        3 * this.moodAngry -
        2 * this.moodSad -
        2 * this.moodHappy) *
      (1 + 0.12 * lookUp - 0.2 * lookDown);
    const eyeRy = Math.max(1.6, eyeOpenRy * this.bf);
    const gap = 5;
    const span = (y: number, ry: number) => [bound(y - ry), bound(y), bound(y + ry)];

    // The divide is not symmetric at eye height: the paper-side eye sits right
    // against it, so a glance towards the ink side would leave that eye stuck
    // and the pair looking at the middle. Where an eye's aim crosses the
    // divide, the eye pushes the face along instead. Measured with the eye
    // open, so a blink does not make the face twitch.
    // Only the overlap beyond the resting pose pushes, so a face at rest
    // stays exactly where it was.
    {
      const lead0 = this.gx - drift;
      const ry = Math.max(1.6, eyeOpenRy);
      const limitL = Math.min(...span(eyeY, ry)) - eyeRx * popL - gap;
      const limitR = Math.max(...span(eyeY, ry)) + eyeRx * popR + gap;
      const restL = cx - 60 + drift - limitL;
      const restR = cx + 40 + drift - limitR;
      const pushR = Math.max(0, restL + lead0 - Math.max(0, restL));
      const pushL = Math.min(0, restR + lead0 - Math.min(0, restR));
      drift += pushR + pushL;
    }
    // Sampled by angle along each half circle, not by height, and joined with
    // Catmull-Rom curves: near the middle and the ends the divide runs almost
    // horizontally, where evenly spaced heights and straight segments showed
    // flat chords and corners.
    const splitPoints = this.splitPoints;
    for (let i = 0; i < SPLIT_SAMPLES.length; i += 1) {
      const sample = SPLIT_SAMPLES[i];
      splitPoints[i][0] = cx + offsetAt(sample.u, sample);
      splitPoints[i][1] = top + sample.u * h;
    }
    let splitCurve = `${pt(splitPoints[0])}`;
    for (let j = 0; j < splitPoints.length - 1; j += 1) {
      const p0 = splitPoints[Math.max(0, j - 1)];
      const p1 = splitPoints[j];
      const p2 = splitPoints[j + 1];
      const p3 = splitPoints[Math.min(splitPoints.length - 1, j + 2)];
      splitCurve +=
        ` C${r1(p1[0] + (p2[0] - p0[0]) / 6)},${r1(p1[1] + (p2[1] - p0[1]) / 6)} ` +
        `${r1(p2[0] - (p3[0] - p1[0]) / 6)},${r1(p2[1] - (p3[1] - p1[1]) / 6)} ${pt(p2)}`;
    }
    const darkD = `M${cx},-80 L${splitCurve} L${cx},480 L480,480 L480,-80 Z`;

    const faceX = cx - 10 + drift;
    const lead = this.gx - drift;
    // Each eye sits on its own colour; never let it cross the divide.
    const bMin = Math.min(...span(eyeY, eyeRy));
    const bMax = Math.max(...span(eyeY, eyeRy));
    const exL = Math.min(faceX - 50 + lead, bMin - eyeRx * popL - gap);
    const exR = Math.max(faceX + 50 + lead, bMax + eyeRx * popR + gap);

    let mx = faceX + lead * 0.6 + think * 6;
    const my = cy + 40 + this.gdy * 0.75;
    const v = this.vow;
    const open = lv * (22 - 8 * v) * (1 - this.listen) * al + 7 * this.moodSurprised;
    const hw =
      17 +
      9 * v * Math.min(1, lv * 2) * al +
      3 * (1 - this.speak) * (1 - think) -
      think * 5 -
      3 * this.moodAngry;
    const reach = Math.max(hw, 32 * this.listen) + 3;
    const mBound = Math.min(bound(my - open), bound(my), bound(my + open * 1.3 + 3));
    if (mx + reach > mBound - 4) mx = mBound - 4 - reach;
    const smile =
      3.5 * (1 - think) -
      think +
      5 * this.moodHappy -
      4 * this.moodSad -
      3 * this.moodAngry;
    const ly0 = my + think * 2;
    const ry0 = my - think * 2;
    const uy = my + smile - open * 0.7;
    const by = my + smile + open * 1.3;
    const mouthD =
      `M${r1(mx - hw)},${r1(ly0)}` +
      `C${r1(mx - hw * 0.55)},${r1(uy)} ${r1(mx + hw * 0.55)},${r1(uy)} ${r1(mx + hw)},${r1(ry0)}` +
      `C${r1(mx + hw * 0.55)},${r1(by)} ${r1(mx - hw * 0.55)},${r1(by)} ${r1(mx - hw)},${r1(ly0)}Z`;

    const amp = Math.min(22, 3 + lv * 40);
    const wave: string[] = [];
    for (const { x, envelope } of WAVE_SAMPLES) {
      const y = my + envelope * amp * (Math.sin(x * 0.9 + t * 14) * 0.7 + Math.sin(x * 1.7 - t * 9) * 0.3);
      wave.push(`${r1(mx + x)},${r1(y)}`);
    }

    // Eyebrows only show for the expressions that need them: happy reads
    // entirely through the smile, so it leaves them at rest.
    const browY = eyeY - eyeRy - 9;
    const browHw = eyeRx + 3;
    const browLift = -6 * this.moodSurprised;
    const browInnerDrop = 5 * this.moodAngry - 4 * this.moodSad;
    const browOuterDrop = -2 * this.moodAngry + 2 * this.moodSad;
    const browPath = (eyeCx: number, innerSign: 1 | -1) => {
      const innerX = eyeCx + innerSign * browHw * 0.85;
      const outerX = eyeCx - innerSign * browHw * 0.85;
      const innerY = browY + browLift + browInnerDrop;
      const outerY = browY + browLift + browOuterDrop;
      const midY = Math.min(innerY, outerY) - 2;
      return `M${r1(outerX)},${r1(outerY)} Q${r1(eyeCx)},${r1(midY)} ${r1(innerX)},${r1(innerY)}`;
    };
    const browOpacity =
      Math.min(1, Math.max(this.moodAngry, this.moodSad, this.moodSurprised)) *
      smoothstep(0.7, 1, morph);

    const beatAmp = 1 + 0.7 * this.beat;
    const upX = 214 + (exR - 214) * morph;
    const upY = 146 + (eyeY - 146) * morph;
    const loX = 188 + (mx - 188) * morph;
    const loY = 244 + (my - 244) * morph;

    return {
      bodyD,
      darkD,
      tilt: `rotate(${r1(this.tilt)} 200 210)`,
      shadowY: r1(356 + lv * 2),
      shadowRx: r1(92 - lv * 8 + Math.sin(t * 1.3) * 2 * al),
      shadowOpacity: Math.round(0.09 * al * 100) / 100,
      eyeLeft: { cx: r1(exL), cy: r1(eyeY), rx: r1(eyeRx * popL), ry: r1(eyeRy * popL) },
      eyeRight: { cx: r1(exR), cy: r1(eyeY), rx: r1(eyeRx * popR), ry: r1(eyeRy * popR) },
      mouthD,
      mouthOpacity: r1((1 - this.listen) * smoothstep(0.5, 1, morph) * 100) / 100,
      waveD: `M${wave.join(" L")}`,
      waveOpacity: r1(this.listen * 100) / 100,
      upperWaveD: logoWave(upX, upY, 27 * (1 - morph) + 0.5, 15 * beatAmp * (1 - morph)),
      upperWaveOpacity: r1((1 - smoothstep(0.7, 1, morph)) * 100) / 100,
      lowerWaveD: logoWave(loX, loY, 27 + (hw - 27) * morph, 15 * beatAmp * (1 - morph)),
      lowerWaveOpacity: r1((1 - smoothstep(0.55, 1, morph)) * 100) / 100,
      browLeftD: browPath(exL, 1),
      browRightD: browPath(exR, -1),
      browOpacity: r1(browOpacity * 100) / 100,
    };
  }
}
