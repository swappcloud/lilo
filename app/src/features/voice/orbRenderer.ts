import type { MusicLevels } from "../../lib/musicLevels";

export type VoicePhase = "idle" | "listening" | "thinking" | "speaking";
/** Visualizers painted on the canvas (the LILO character is SVG). */
export type CanvasVizMode = "orb" | "bars";
export type Rgb = [number, number, number];

const PALETTE: Record<VoicePhase, [Rgb, Rgb]> = {
  idle: [
    [99, 102, 241],
    [168, 85, 247],
  ],
  listening: [
    [59, 130, 246],
    [34, 211, 238],
  ],
  thinking: [
    [139, 92, 246],
    [99, 102, 241],
  ],
  speaking: [
    [236, 72, 153],
    [245, 158, 11],
  ],
};

const WHITE: Rgb = [255, 255, 255];
const DEEP: Rgb = [10, 10, 25];
const HIST = 128;
/** How much of the phase palette shows through the chosen accent colour. */
const PHASE_TINT = 0.35;
/** Bins of the synthetic spectrum used while music plays. */
const MUSIC_BINS = 28;

/**
 * A plausible spectrum for local playback.
 *
 * mpv runs outside the WebAudio graph, so there is nothing real to read. A sum
 * of sines gives the orb a living silhouette and a dancing spoke ring instead
 * of the barely-visible idle breath.
 */
function fillMusicSpectrum(out: number[], t: number): number[] {
  for (let i = 0; i < MUSIC_BINS; i += 1) {
    const p = i / (MUSIC_BINS - 1);
    const v =
      0.34 +
      0.3 * Math.abs(Math.sin(t * 2.1 + p * 5.6)) +
      0.2 * Math.abs(Math.sin(t * 3.7 - p * 3.1)) +
      0.12 * Math.abs(Math.sin(t * 6.3 + p * 9.2));
    // Tilt the top end down so it reads as music rather than noise.
    out[i] = Math.min(1, v * (1 - p * 0.38));
  }
  return out;
}

/**
 * A spectrum shaped by the track mpv is playing.
 *
 * mpv reports one loudness per band — low, mid, high — not a spectrum; the
 * bins are built from those, kept moving with the same sines so the silhouette
 * reads as music instead of three flat blocks.
 */
export function musicBinsFrom(levels: MusicLevels, out: number[], t: number): number[] {
  for (let i = 0; i < MUSIC_BINS; i += 1) {
    const p = i / (MUSIC_BINS - 1);
    const band = p < 0.35 ? levels.low : p > 0.62 ? levels.high : levels.low * 0.5 + levels.high * 0.5;
    const texture = 0.85 + 0.3 * Math.abs(Math.sin(t * 2.1 + p * 5.6));
    out[i] = Math.min(1, Math.max(0, band * texture));
  }
  return out;
}

export function paletteFor(phase: VoicePhase): [Rgb, Rgb] {
  return PALETTE[phase];
}

/** `#6366f1` / `#abc` → `[99, 102, 241]`. */
export function hexToRgb(hex: string): Rgb {
  const clean = hex.trim().replace(/^#/, "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean.padEnd(6, "0").slice(0, 6);
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return [...PALETTE.idle[0]] as Rgb;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const mix = (a: Rgb, b: Rgb, k: number): Rgb => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
];
const rgb = (c: Rgb) => `rgb(${c.map(Math.round).join(",")})`;
const rgba = (c: Rgb, alpha: number) =>
  `rgba(${c.map(Math.round).join(",")},${alpha})`;

/**
 * The accent colour dominates so switching accent recolours the visual, while
 * a little of the phase palette keeps idle/listening/thinking/speaking
 * distinguishable.
 */
export function phaseAccent(phase: VoicePhase, accent: [Rgb, Rgb]): [Rgb, Rgb] {
  const base = paletteFor(phase);
  return [mix(accent[0], base[0], PHASE_TINT), mix(accent[1], base[1], PHASE_TINT)];
}

/** Publish the live glow colours that the CSS (captions, pills) reads. */
export function publishAccentVars(c1: Rgb, c2: Rgb): void {
  const root = document.documentElement;
  const next = {
    "--c1": rgb(c1),
    "--c2": rgb(c2),
    "--c1a": rgba(c1, 0.5),
    "--c2a": rgba(c2, 0.42),
  };
  for (const [key, value] of Object.entries(next)) {
    if (root.style.getPropertyValue(key) !== value) {
      root.style.setProperty(key, value);
    }
  }
}

export interface FrameOptions {
  phase: VoicePhase;
  energy: number;
  viz: CanvasVizMode;
  animations: boolean;
  /** Accent brand colours — blended into every phase so the accent drives the orb. */
  accent: [Rgb, Rgb];
  /** Normalized frequency bins (0..1) of whichever voice is currently active. */
  spectrum: number[];
  /**
   * Local music is playing. mpv is outside the WebAudio graph, so there is no
   * spectrum to read; the orb instead pulses on its own, which keeps the
   * "something is playing" motion where the voice animation already lives.
   */
  music: boolean;
  /**
   * Live loudness of the track, when the player reports it. With it the orb
   * and the bars follow the actual music; without it they fall back to the
   * synthetic pulse above.
   */
  musicLevels?: MusicLevels | null;
}

/**
 * Imperative canvas renderer for the voice visualization.
 *
 * Kept out of React on purpose: the animation loop mutates a lot of state every
 * frame, which must not trigger re-renders. The orb/bars geometry is driven by
 * the live voice spectrum so the animation reflects what is actually being said.
 */
export class OrbRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  /** Orb centre + base radius in device pixels (set from the layout target). */
  private centerX = 0;
  private centerY = 0;
  private baseRadius = 0;

  private c1: Rgb = [...PALETTE.idle[0]];
  private c2: Rgb = [...PALETTE.idle[1]];
  private amp = 0;
  private radius = 0;
  private offset = 0;
  private lastRipple = 0;
  private spectrum: number[] = [];
  /** Reused buffer for the synthetic music spectrum (no per-frame garbage). */
  private readonly musicBins = new Array<number>(MUSIC_BINS).fill(0);
  /** Voice or music is audible: drives ripples and the spoke ring. */
  private reactive = false;
  private readonly history = new Array<number>(HIST).fill(0);
  private readonly ripples: Array<{ r: number; a: number }> = [];

  constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.canvas = canvas;
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width * dpr;
    this.height = height * dpr;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.floor(this.width));
    this.canvas.height = Math.max(1, Math.floor(this.height));
  }

  /**
   * Position the orb using the layout element's rect (CSS px). The canvas can
   * cover the whole window while the orb stays where the UI expects it — and
   * because the canvas is full-bleed, no square boundary is ever visible.
   */
  setGeometry(centerX: number, centerY: number, baseRadius: number): void {
    this.centerX = centerX * this.dpr;
    this.centerY = centerY * this.dpr;
    this.baseRadius = baseRadius * this.dpr;
  }

  resetCenter(): void {
    this.centerX = 0;
    this.centerY = 0;
    this.baseRadius = 0;
  }

  render(t: number, dt: number, options: FrameOptions): void {
    const { ctx } = this;
    if (!this.width || !this.height) return;

    const phase = options.phase;
    const palette = phaseAccent(phase, options.accent);
    // The assistant's own voice always wins. Otherwise music is the subject:
    // the phase is "listening" for the whole time a session is live, and with
    // headphones the microphone hears nothing, so keying the envelope off the
    // mic left the orb frozen while a song was clearly playing.
    const musicOnly =
      options.music && phase !== "speaking" && phase !== "thinking";

    const providedEnergy = options.spectrum.length
      ? options.spectrum.reduce((sum, value) => sum + value, 0) /
        options.spectrum.length
      : 0;
    const useMusicSpectrum =
      musicOnly && (options.spectrum.length === 0 || providedEnergy < 0.02);

    const levels = musicOnly ? (options.musicLevels ?? null) : null;
    this.spectrum = useMusicSpectrum
      ? levels
        ? musicBinsFrom(levels, this.musicBins, t)
        : fillMusicSpectrum(this.musicBins, t)
      : options.spectrum;
    // Music gets the same ripples and spoke ring as a voice, so the orb is the
    // single place where "audio is happening" is shown.
    this.reactive =
      options.music || phase === "listening" || phase === "speaking";

    const spectrumEnergy = this.spectrum.length
      ? this.spectrum.reduce((sum, value) => sum + value, 0) /
        this.spectrum.length
      : 0;

    // Target amplitude: real mic/output energy (plus live spectrum), with a
    // gentle idle breath otherwise.
    const target = musicOnly
      ? levels
        ? Math.max(0.08, levels.level * 0.85)
        : 0.2 + 0.16 * Math.abs(Math.sin(t * 2.1))
      : phase === "speaking"
        ? Math.max(options.energy, spectrumEnergy * 1.5, 0.18)
        : phase === "listening"
          ? Math.max(options.energy, spectrumEnergy * 1.5)
          : phase === "thinking"
            ? 0.14 + 0.1 * Math.sin(t * 4)
            : 0.05 + 0.04 * Math.sin(t * 1.6);

    const smoothing = options.animations ? 0.18 : 1;
    this.amp += (target - this.amp) * smoothing;
    this.history[this.offset % HIST] = this.amp;

    const lerp = options.animations ? 0.05 : 1;
    this.c1 = mix(this.c1, palette[0], lerp);
    this.c2 = mix(this.c2, palette[1], lerp);
    this.publishAccent();

    ctx.clearRect(0, 0, this.width, this.height);
    const cx = this.centerX || this.width / 2;
    const cy = this.centerY || this.height / 2;
    const baseRadius =
      this.baseRadius || Math.min(this.width, this.height) * 0.3;
    const breathe = options.animations ? Math.sin(t * 1.6) * 0.025 : 0;

    const wanted =
      baseRadius *
      (musicOnly
        ? 1.06 + this.amp * 0.1
        : phase === "listening"
          ? 1.12 + this.amp * 0.1
          : phase === "thinking"
            ? 0.92
            : phase === "speaking"
              ? 1.06 + this.amp * 0.08
              : 1 + breathe);
    this.radius = this.radius
      ? this.radius + (wanted - this.radius) * 0.12
      : wanted;
    const radius = this.radius;

    if (options.viz === "orb") {
      this.drawOrb(cx, cy, radius, t, dt, options);
    } else {
      this.drawBars(cy);
    }

    this.offset += 1;
  }

  private sample(index: number): number {
    return this.history[((index % HIST) + HIST) % HIST];
  }

  /** Frequency value at a normalized position (0..1) across the spectrum. */
  private bin(position: number): number {
    const bins = this.spectrum.length;
    if (!bins) return 0;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(position * bins)));
    return this.spectrum[idx];
  }

  /** Voice-reactive blob. Extra spectrum-driven ripple makes it "talk". */
  private blob(
    cx: number,
    cy: number,
    radius: number,
    depth: number,
    t: number,
    spectrum: number[],
  ): void {
    const { ctx } = this;
    ctx.beginPath();
    const steps = 120;
    const bins = spectrum.length;
    for (let i = 0; i <= steps; i += 1) {
      const a = (i / steps) * Math.PI * 2;
      let w =
        1 +
        depth *
          (0.05 * Math.sin(3 * a + t * 1.4) +
            0.032 * Math.sin(5 * a - t * 1.1) +
            0.02 * Math.sin(8 * a + t * 0.7));
      if (bins) {
        // Mirror the spectrum across the vertical axis so the silhouette
        // bulges symmetrically, like a voice rippling around a ring.
        const half = i <= steps / 2 ? i : steps - i;
        const idx = Math.min(
          bins - 1,
          Math.floor((half / (steps / 2)) * bins),
        );
        w += spectrum[idx] * 0.22;
      }
      const x = cx + Math.cos(a) * radius * w;
      const y = cy + Math.sin(a) * radius * w;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.closePath();
  }

  private drawOrb(
    cx: number,
    cy: number,
    radius: number,
    t: number,
    _dt: number,
    options: FrameOptions,
  ): void {
    const { ctx, dpr } = this;
    const amp = this.amp;
    // The synthesized music spectrum lives on `this`; using the raw options
    // here would leave the orb flat whenever music is the only audio.
    const spectrum = this.spectrum;

    if (
      options.animations &&
      this.reactive &&
      amp > 0.25 &&
      t - this.lastRipple > 0.45
    ) {
      this.ripples.push({ r: radius + 8, a: 0.4 });
      this.lastRipple = t;
    }

    for (let i = this.ripples.length - 1; i >= 0; i -= 1) {
      const ripple = this.ripples[i];
      ripple.r += (2 + amp * 4) * dpr;
      ripple.a *= 0.955;
      const edge = Math.min(this.width, this.height) * 0.5;
      if (ripple.a < 0.02 || ripple.r > edge + 18 * dpr) {
        this.ripples.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.arc(cx, cy, ripple.r, 0, 7);
      ctx.strokeStyle = rgba(this.c2, ripple.a);
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
    }

    // Glow must reach full transparency *before* the canvas edge, otherwise the
    // square canvas boundary becomes visible.
    const edge = Math.min(this.width, this.height) * 0.5;
    const glow = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, edge);
    glow.addColorStop(0, rgba(this.c1, 0.28 + amp * 0.22));
    glow.addColorStop(0.6, rgba(this.c1, 0.08 + amp * 0.06));
    glow.addColorStop(1, "transparent");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, this.width, this.height);

    const depth =
      options.phase === "idle"
        ? 0.35
        : options.phase === "thinking"
          ? 0.45
          : 0.5 + amp * 0.7;

    ctx.save();
    ctx.shadowColor = rgba(this.c1, 0.85);
    ctx.shadowBlur = (34 + amp * 44) * dpr;
    this.blob(cx, cy, radius, depth, t, spectrum);
    const fill = ctx.createRadialGradient(
      cx - radius * 0.35,
      cy - radius * 0.4,
      radius * 0.1,
      cx,
      cy,
      radius * 1.25,
    );
    fill.addColorStop(0, rgba(mix(this.c1, WHITE, 0.5), 1));
    fill.addColorStop(0.5, rgb(this.c1));
    fill.addColorStop(1, rgb(mix(this.c2, DEEP, 0.15)));
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();

    this.blob(cx, cy, radius, depth, t, spectrum);
    ctx.strokeStyle = "rgba(255,255,255,.25)";
    ctx.lineWidth = 1.2 * dpr;
    ctx.stroke();

    // Inner veils, clipped to the blob.
    ctx.save();
    this.blob(cx, cy, radius, depth, t, spectrum);
    ctx.clip();
    for (let k = 0; k < 3; k += 1) {
      ctx.beginPath();
      for (let x = -radius; x <= radius; x += 6 * dpr) {
        const edgeFactor = Math.cos((x / radius) * 1.4);
        const y =
          Math.sin(
            (x * 0.012) / dpr +
              t * (options.phase === "thinking" ? 3 : 1.2) +
              k * 2.1,
          ) *
          radius *
          0.28 *
          edgeFactor;
        if (x === -radius) ctx.moveTo(cx + x, cy + y);
        else ctx.lineTo(cx + x, cy + y);
      }
      ctx.strokeStyle = `rgba(255,255,255,${0.16 - k * 0.04})`;
      ctx.lineWidth = 2 * dpr;
      ctx.shadowColor = rgb(this.c2);
      ctx.shadowBlur = 12 * dpr;
      ctx.stroke();
    }
    ctx.restore();

    if (options.phase === "thinking") {
      const a0 = t * 2.4;
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 22 * dpr, 0, 7);
      ctx.strokeStyle = "rgba(255,255,255,.08)";
      ctx.lineWidth = 3 * dpr;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 22 * dpr, a0, a0 + 1.3);
      ctx.strokeStyle = rgb(this.c2);
      ctx.lineCap = "round";
      ctx.lineWidth = 3.5 * dpr;
      ctx.shadowColor = rgb(this.c2);
      ctx.shadowBlur = 16 * dpr;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Ring of voice-reactive spikes: each spoke is as long as the matching
    // frequency bin, so the ring literally dances to the voice.
    if (this.reactive) {
      const bars = 72;
      const min = Math.min(this.width, this.height);
      for (let i = 0; i < bars; i += 1) {
        const a = (i / bars) * Math.PI * 2 - Math.PI / 2;
        const v = spectrum.length
          ? spectrum[Math.min(spectrum.length - 1, Math.floor((i / bars) * spectrum.length))]
          : this.sample(this.offset - i * 2) * 0.6;
        const len = (4 + v * min * 0.18) * dpr;
        const r0 = radius + 16 * dpr;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(
          cx + Math.cos(a) * (r0 + len),
          cy + Math.sin(a) * (r0 + len),
        );
        ctx.strokeStyle = rgba(mix(this.c1, this.c2, i / bars), 0.85);
        ctx.lineCap = "round";
        ctx.lineWidth = 3 * dpr;
        ctx.stroke();
      }
    }
  }

  private drawBars(cy: number): void {
    const { ctx } = this;
    const bars = 56;
    const barWidth = (this.width * 0.84) / bars;
    for (let i = 0; i < bars; i += 1) {
      const v = this.spectrum.length
        ? this.bin(i / bars)
        : this.sample(this.offset - i * 2) * 0.6;
      const height = 6 + v * this.height * 0.42;
      ctx.fillStyle = rgba(mix(this.c1, this.c2, i / bars), 0.9);
      const x = this.width * 0.08 + i * barWidth + barWidth * 0.2;
      const w = barWidth * 0.6;
      const y = cy - height / 2;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, w, height, w * 0.5);
      } else {
        ctx.rect(x, y, w, height);
      }
      ctx.fill();
    }
  }

  private publishAccent(): void {
    publishAccentVars(this.c1, this.c2);
  }
}