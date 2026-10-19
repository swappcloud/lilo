import type { Scene, SceneKind } from "../../types";

/**
 * Background scenes (rain, snow, storm, …) drawn on one full-window canvas.
 *
 * The look is ported from the `weather-motion` effect used on swappscloud.com:
 * one particle field whose only colour is the accent, one behaviour per scene,
 * and lightning that is actual bolts instead of a tinted flash. Plugins only
 * name a scene; every pixel is drawn here, from a fixed vocabulary, so a
 * marketplace plugin can change the mood of the app without shipping code that
 * runs in the page.
 *
 * Budget: the reference particle counts are kept (110–140 for snow/rain/storm),
 * scaled by window area, DPR is capped at 1.5 and everything is one pass of
 * fills and short strokes — the same envelope a headless Linux device can draw. Alphas
 * run a touch above the reference: our canvas sits behind the aurora, which the
 * plain site does not have, and at the reference values the motes read as
 * nothing.
 */

/** Scenes the motion model draws. */
export type MotionScene = "clear" | "heat" | "cold" | "snow" | "rain" | "storm" | "fog";

/** Particles per scene, before the area scale (from the reference effect). */
const BASE_COUNT: Record<MotionScene, number> = {
  clear: 26,
  heat: 30,
  cold: 26,
  snow: 110,
  rain: 120,
  storm: 140,
  fog: 26,
};

/** The counts above were tuned for this many CSS px. */
const REFERENCE_AREA = 1024 * 1000;
const MIN_AREA_SCALE = 0.35;
const MAX_AREA_SCALE = 1.6;
/** Narrow windows get fewer particles: a phone-sized canvas shows them denser. */
const NARROW_WIDTH = 720;
const NARROW_SCALE = 0.45;

const MAX_SPLASHES = 36;
const BOLT_LIFE = 0.22;
const FRAME = 1 / 60;
const FADE_SECS = 1.2;

/** How our scene vocabulary maps onto the motion model. */
const MOTION_KIND: Record<SceneKind, MotionScene> = {
  none: "clear",
  clear: "clear",
  // No sun and no cloud bank in the reference effect: sunshine is the drifting
  // motes of a clear sky, overcast is the soft fog bank.
  sun: "clear",
  clouds: "fog",
  fog: "fog",
  rain: "rain",
  snow: "snow",
  storm: "storm",
  heat: "heat",
  cold: "cold",
};

export interface MotionConfig {
  scene: MotionScene;
  /** Drift and streak slant; the reference default is 8. */
  wind: number;
  /** 0..100 strength, from `Scene.intensity`. */
  precip: number;
  /** 1 at night. Part of the reference contract. */
  night: number;
}

/** A plugin scene, translated into what the motion model reads. */
export function motionFor(scene: Scene): MotionConfig {
  return {
    scene: MOTION_KIND[scene.kind],
    wind: 8,
    precip: Math.round(Math.max(0, Math.min(1, scene.intensity)) * 100),
    night: scene.night ? 1 : 0,
  };
}

/** How many particles a scene gets on a canvas this size. */
export function particleCount(scene: MotionScene, width: number, height: number): number {
  const area = (width * height) / REFERENCE_AREA;
  const scale = Math.min(Math.max(area, MIN_AREA_SCALE), MAX_AREA_SCALE);
  const narrow = width < NARROW_WIDTH ? NARROW_SCALE : 1;
  return Math.round(BASE_COUNT[scene] * scale * narrow);
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

interface Particle {
  x: number;
  y: number;
  /** Radius. */
  r: number;
  /** Depth 0..1: drives speed, size, alpha. */
  z: number;
  /** Random phase. */
  s: number;
}

interface Splash {
  x: number;
  r: number;
  life: number;
}

/** A forked bolt: the trunk, then the branches off it. */
interface Bolt {
  pts: Array<[number, number]>;
  branches: Array<Array<[number, number]>>;
  life: number;
}

/** One scene's particles, splashes and lightning, with no canvas attached. */
export class MotionField {
  private config: MotionConfig;
  private width = 0;
  private height = 0;
  /** Seconds since the field was created; drives the drift sines. */
  private t = 0;
  private particles: Particle[] = [];
  private splashes: Splash[] = [];
  private bolts: Bolt[] = [];
  private flash = 0;

  constructor(config: MotionConfig, width: number, height: number) {
    this.config = config;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.spawn();
  }

  /** Follow the config. A scene change respawns the field; the rest is live. */
  set(config: MotionConfig): void {
    const changed = config.scene !== this.config.scene;
    this.config = config;
    if (changed) this.spawn();
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.spawn();
  }

  /** True while lightning is on screen (the loop must keep drawing). */
  get lightning(): boolean {
    return this.bolts.length > 0 || this.flash > 0;
  }

  private spawn(): void {
    const count = particleCount(this.config.scene, this.width, this.height);
    this.particles = Array.from({ length: count }, () => ({
      x: Math.random() * this.width,
      y: Math.random() * this.height,
      r: Math.random() * 2 + 0.5,
      z: Math.random(),
      s: Math.random(),
    }));
    this.splashes = [];
    this.bolts = [];
  }

  /** A forked bolt falling from the top of the window. */
  private strike(): Bolt {
    const trunk: Array<[number, number]> = [
      [Math.random() * this.width * 0.7 + this.width * 0.15, -10],
    ];
    while (trunk[trunk.length - 1][1] < this.height * 0.7) {
      const [x, y] = trunk[trunk.length - 1];
      trunk.push([x + rand(-14, 14), y + rand(10, 22)]);
    }
    const branches: Array<Array<[number, number]>> = [];
    const branchCount = Math.random() < 0.5 ? 1 : 2;
    for (let i = 0; i < branchCount; i += 1) {
      let point = trunk[Math.floor(Math.random() * (trunk.length - 2)) + 1];
      const branch: Array<[number, number]> = [[point[0], point[1]]];
      const segments = 2 + Math.floor(Math.random() * 3);
      for (let j = 0; j < segments; j += 1) {
        point = [point[0] + rand(-20, 20), point[1] + rand(6, 14)];
        branch.push([point[0], point[1]]);
      }
      branches.push(branch);
    }
    return { pts: trunk, branches, life: BOLT_LIFE };
  }

  /**
   * Advance `dt` seconds. The reference effect is written per 60 fps frame, so
   * every constant is scaled by the frames that elapsed.
   */
  step(dt: number): void {
    const frames = Math.min(dt, 0.05) / FRAME;
    this.t += Math.min(dt, 0.05);
    const { scene, wind, precip } = this.config;
    const drift = wind / 80;
    const strength = precip / 100;
    const raining = scene === "rain" || scene === "storm";

    for (const p of this.particles) {
      if (raining) {
        p.x += (drift * 9 + 1.4) * frames;
        p.y += (7 + strength * 9 + p.z * 6) * frames;
      } else if (scene === "snow") {
        p.x += (Math.sin(this.t + p.s * 8) * 0.5 + drift * 2) * frames;
        p.y += (0.7 + p.z * 1.6) * frames;
      } else if (scene === "fog") {
        p.x += (0.3 + drift) * frames;
        p.y += Math.sin(this.t * 0.3 + p.s * 4) * 0.06 * frames;
      } else if (scene === "heat") {
        p.x += (Math.sin(this.t * 0.6 + p.s * 6) * 0.3 + drift) * frames;
        p.y += (-0.35 + p.z * 0.7) * frames;
      } else {
        p.x += (drift * 1.4 + 0.12) * frames;
        p.y += Math.sin(this.t + p.s * 3) * 0.16 * frames;
      }

      if (p.y > this.height + 24) {
        // A drop that lands leaves a splash on the floor.
        if (raining && this.splashes.length < MAX_SPLASHES && Math.random() < 0.3) {
          this.splashes.push({ x: p.x, r: 1.5, life: 1 });
        }
        p.y = -24;
      }
      if (p.y < -24) p.y = this.height + 24;
      if (p.x > this.width + 24) p.x = -24;
      if (p.x < -24) p.x = this.width + 24;
    }

    for (const splash of this.splashes) {
      splash.r += 0.5 * frames;
      splash.life -= 0.04 * frames;
    }
    this.splashes = this.splashes.filter((splash) => splash.life > 0);

    if (scene === "storm" && Math.random() < 0.0022 * frames) {
      this.bolts.push(this.strike());
      this.flash = Math.max(this.flash, 0.1);
    }
    for (const bolt of this.bolts) bolt.life -= 0.016 * frames;
    this.bolts = this.bolts.filter((bolt) => bolt.life > 0);
    // Distant thunder between strikes: the sky flickers without a bolt.
    if (scene === "storm" && this.bolts.length === 0 && Math.random() < 0.0035 * frames) {
      this.flash = 0.13;
    }
    if (this.flash > 0) this.flash = Math.max(0, this.flash - 0.016 * frames);
  }

  /** Paint the field. `tint` is the accent the whole effect is drawn with. */
  draw(
    ctx: CanvasRenderingContext2D,
    alpha: number,
    dark: boolean,
    tint: { r: number; g: number; b: number },
  ): void {
    const { scene, wind, precip } = this.config;
    const { width, height } = this;

    const stroke = withAlpha(tint, 1);

    if (scene === "rain" || scene === "storm") {
      ctx.save();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 0.9;
      const length = 12 + precip / 7;
      for (const p of this.particles) {
        ctx.globalAlpha = (0.08 + p.z * 0.22) * alpha;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - wind * 0.06, p.y + length + p.z * 6);
        ctx.stroke();
      }
      ctx.restore();

      if (this.splashes.length > 0) {
        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = stroke;
        for (const splash of this.splashes) {
          ctx.globalAlpha = 0.16 * splash.life * alpha;
          ctx.beginPath();
          ctx.ellipse(splash.x, height - 4, splash.r * 2.4, splash.r * 0.8, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }
    } else if (scene === "snow") {
      ctx.save();
      ctx.fillStyle = dark ? "#eefaff" : "rgb(125, 145, 175)";
      for (const p of this.particles) {
        ctx.globalAlpha = (0.18 + p.z * 0.5) * alpha * (dark ? 1 : 0.8);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (0.8 + p.z), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    } else if (scene === "fog") {
      // Soft banks: a squashed radial gradient per particle.
      for (const p of this.particles) {
        const radius = 150 + p.z * 90;
        const squash = 22 + p.z * 16;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.scale(1, squash / radius);
        const bank = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
        const green = dark ? p.s * 0.04 + 0.06 : p.s * 0.05 + 0.08;
        bank.addColorStop(0, withAlpha(tint, green * alpha));
        bank.addColorStop(1, withAlpha(tint, 0));
        ctx.fillStyle = bank;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    } else {
      // Clear, heat and cold are the same drifting motes in the accent.
      ctx.save();
      ctx.fillStyle = stroke;
      for (const p of this.particles) {
        ctx.globalAlpha = (0.1 + p.s * 0.26) * alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (0.9 + p.z), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    if (this.bolts.length > 0) {
      ctx.save();
      ctx.lineWidth = 1.1;
      ctx.strokeStyle = "rgb(235, 242, 255)";
      ctx.shadowColor = "rgba(190, 215, 255, 0.9)";
      ctx.shadowBlur = 10;
      for (const bolt of this.bolts) {
        ctx.globalAlpha = Math.max((bolt.life / BOLT_LIFE) * 0.5, 0) * alpha;
        ctx.beginPath();
        bolt.pts.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        ctx.lineWidth = 0.8;
        for (const branch of bolt.branches) {
          ctx.beginPath();
          branch.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.stroke();
        }
        ctx.lineWidth = 1.1;
      }
      ctx.restore();
    }

    if (this.flash > 0) {
      ctx.save();
      ctx.fillStyle = `rgba(226, 238, 255, ${Math.max(this.flash * 1.25, 0) * alpha})`;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
  }
}

/** Parse `#rgb`, `#rrggbb`, `rgb()` or `rgba()`; the reference effect's fallback. */
export function parseColor(value: string): { r: number; g: number; b: number } {
  const text = value.trim();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3) {
      digits = digits
        .split("")
        .map((digit) => digit + digit)
        .join("");
    }
    const value = parseInt(digits, 16);
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
  }
  const parts = text.match(/rgba?\(([^)]+)\)/);
  if (parts) {
    const [r, g, b] = parts[1].split(",");
    return { r: Number(r) || 0, g: Number(g) || 0, b: Number(b) || 0 };
  }
  return { r: 91, g: 140, b: 255 };
}

/** `rgba()` from a parsed colour and an alpha. */
function withAlpha(rgb: { r: number; g: number; b: number }, alpha: number): string {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/** One scene's motion field, and how visible it currently is. */
class Layer {
  readonly scene: Scene;
  alpha = 0;
  private readonly field: MotionField;

  constructor(scene: Scene, width: number, height: number) {
    this.scene = scene;
    this.field = new MotionField(motionFor(scene), width, height);
  }

  setConfig(scene: Scene, width: number, height: number): void {
    this.field.set(motionFor(scene));
    this.field.resize(width, height);
  }

  step(dt: number): void {
    this.field.step(dt);
  }

  draw(
    ctx: CanvasRenderingContext2D,
    dark: boolean,
    tint: { r: number; g: number; b: number },
  ): void {
    this.field.draw(ctx, this.alpha, dark, tint);
  }
}

export class SceneRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly canvas: HTMLCanvasElement;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private accent = { r: 99, g: 102, b: 241 };
  private layers: Layer[] = [];

  constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.canvas = canvas;
    this.ctx = ctx;
  }

  /** The palette colour every particle is drawn with. */
  setAccent(color: string): void {
    this.accent = parseColor(color);
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    // Capped like the reference effect: the extra pixels are not worth the
    // fill rate on a big display, and a Pi-class board never sees them.
    this.dpr = Math.min(dpr, width < NARROW_WIDTH ? 1 : 1.5);
    this.canvas.width = Math.max(1, Math.floor(width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(height * this.dpr));
    for (const layer of this.layers) layer.setConfig(layer.scene, width, height);
  }

  /** Cross-fade to `scene`. The same scene again is a no-op. */
  setScene(next: Scene | null, animated: boolean): void {
    const scene: Scene = next ?? { kind: "none", intensity: 0, night: false };
    const top = this.layers[this.layers.length - 1];
    const same =
      top &&
      top.scene.kind === scene.kind &&
      Math.abs(top.scene.intensity - scene.intensity) < 0.05 &&
      top.scene.night === scene.night;
    if (same) return;
    // "none" is a layer too: as the newest layer it makes every older one fade.
    const layer = new Layer(scene, this.width, this.height);
    if (!animated) {
      layer.alpha = 1;
      this.layers = [layer];
      return;
    }
    this.layers.push(layer);
  }

  /** Something is still moving or fading. */
  get active(): boolean {
    return this.layers.some((layer) => layer.scene.kind !== "none");
  }

  render(dt: number, dark: boolean): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const step = Math.min(dt, 0.05);
    const last = this.layers.length - 1;
    this.layers.forEach((layer, index) => {
      const target = index === last ? 1 : 0;
      const rate = step / FADE_SECS;
      layer.alpha = target > layer.alpha ? Math.min(1, layer.alpha + rate) : Math.max(0, layer.alpha - rate);
    });
    this.layers = this.layers.filter((layer, index) => index === last || layer.alpha > 0);

    for (const layer of this.layers) {
      if (layer.alpha <= 0 || layer.scene.kind === "none") continue;
      layer.step(step);
      layer.draw(ctx, dark, this.accent);
    }
  }
}
