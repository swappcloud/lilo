import type { AudioFrame } from "../../../lib/audioBus";
import type { VoicePhase } from "../orbRenderer";
import type { LiloFrame, LiloInput } from "./liloModel";

/**
 * Copies a `LiloFrame` into SVG attributes.
 *
 * It binds to elements by `data-lilo` name, so the same renderer drives both
 * the React figure and the static markup of the startup splash in
 * `index.html`. Writes are skipped when a value did not change: most of the
 * face is still most of the time.
 */
export class LiloRenderer {
  private readonly nodes: Record<string, Element[]> = {};
  private readonly written = new Map<Element, Map<string, string>>();

  constructor(root: ParentNode) {
    for (const node of Array.from(root.querySelectorAll("[data-lilo]"))) {
      const name = node.getAttribute("data-lilo") ?? "";
      (this.nodes[name] ??= []).push(node);
    }
  }

  draw(frame: LiloFrame): void {
    this.set("body", "d", frame.bodyD);
    this.set("split", "d", frame.darkD);
    this.set("tilt", "transform", frame.tilt);
    this.set("shadow", "cy", frame.shadowY);
    this.set("shadow", "rx", frame.shadowRx);
    this.set("shadow", "opacity", frame.shadowOpacity);
    this.ellipse("eye-left", frame.eyeLeft);
    this.ellipse("eye-right", frame.eyeRight);
    this.path("mouth", frame.mouthD, frame.mouthOpacity);
    this.path("wave", frame.waveD, frame.waveOpacity);
    this.path("wave-upper", frame.upperWaveD, frame.upperWaveOpacity);
    this.path("wave-lower", frame.lowerWaveD, frame.lowerWaveOpacity);
    this.path("brow-left", frame.browLeftD, frame.browOpacity);
    this.path("brow-right", frame.browRightD, frame.browOpacity);
  }

  private path(name: string, d: string, opacity: number): void {
    // Hidden paths need no SVG parsing or geometry invalidation. Catch up
    // before making them visible, including the first frame of a fade.
    if (opacity > 0) this.set(name, "d", d);
    this.set(name, "opacity", opacity);
  }

  private ellipse(name: string, e: LiloFrame["eyeLeft"]): void {
    this.set(name, "cx", e.cx);
    this.set(name, "cy", e.cy);
    this.set(name, "rx", e.rx);
    this.set(name, "ry", e.ry);
  }

  private set(name: string, attr: string, value: string | number): void {
    const text = String(value);
    for (const node of this.nodes[name] ?? []) {
      let cache = this.written.get(node);
      if (!cache) {
        cache = new Map();
        this.written.set(node, cache);
      }
      if (cache.get(attr) === text) continue;
      cache.set(attr, text);
      node.setAttribute(attr, text);
    }
  }
}

/** Mean of `bins[from..to)`, 0 when out of range. */
function band(bins: number[], from: number, to: number): number {
  const end = Math.min(bins.length, to);
  if (end <= from) return 0;
  let sum = 0;
  for (let i = from; i < end; i += 1) sum += bins[i];
  return sum / (end - from);
}

/**
 * Turn the audio bus frame into what the character's face reads.
 *
 * Levels on the bus are `rms * 2`; speech sits around 0.1–0.4, so it is gated
 * and expanded to use the whole 0..1 range. The 48 spectrum bins are ~280 Hz
 * each: bins 0–1 carry the voice fundamental (jaw), 3–10 the formants that
 * shape vowels. `null` level means "nothing live — synthesize".
 */
export function voiceLevels(
  phase: VoicePhase,
  frame: AudioFrame | null,
): Pick<LiloInput, "level" | "low" | "high"> {
  if (!frame || (phase !== "speaking" && phase !== "listening")) {
    return { level: null };
  }
  const speaking = phase === "speaking";
  const raw = speaking ? frame.output : frame.mic;
  const bins = speaking ? frame.spectrum : frame.micSpectrum;
  // Speaking with a silent analyser (not attached yet): let the model lip-sync.
  if (speaking && raw <= 0 && bins.length === 0) return { level: null };
  const gate = raw < 0.024 ? 0 : 1;
  const level = Math.min(1, Math.max(0, (raw - 0.024) * 3.5));
  return {
    level,
    low: Math.min(1, band(bins, 0, 2) * 1.4) * gate,
    high: Math.min(1, band(bins, 3, 11) * 2.2) * gate,
  };
}
