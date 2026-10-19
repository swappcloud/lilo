import { useEffect, useRef, type RefObject } from "react";

import { EMPTY_SPECTRUM, latestAudioFrame } from "../../lib/audioBus";
import { musicLevels } from "../../lib/musicLevels";
import { runVisibleAnimationLoop } from "../../shared/lib/visibleRaf";
import {
  OrbRenderer,
  type Rgb,
  type CanvasVizMode,
  type VoicePhase,
} from "./orbRenderer";

export interface OrbVisualizerOptions {
  phase: VoicePhase;
  energy: number;
  viz: CanvasVizMode;
  animations: boolean;
  accent: [Rgb, Rgb];
  /** Local music is playing; see `OrbRenderer`. */
  music: boolean;
}

/** Pick the spectrum that matches the active voice. */
function spectrumFor(phase: VoicePhase): number[] {
  const frame = latestAudioFrame();
  if (!frame) return EMPTY_SPECTRUM;
  if (phase === "listening") return frame.micSpectrum;
  if (phase === "speaking" || phase === "thinking") return frame.spectrum;
  return EMPTY_SPECTRUM;
}

/**
 * Everything the renderer needs this frame: the voice spectrum, and the live
 * loudness of whatever mpv is playing (read from the bus, never from React
 * state, so a 60fps poll costs no re-renders).
 */
function frameOptions(current: OrbVisualizerOptions, animations: boolean) {
  return {
    ...current,
    animations,
    spectrum: spectrumFor(current.phase),
    musicLevels: current.music ? musicLevels() : null,
  };
}

/**
 * Drives the full-bleed orb canvas.
 *
 * The canvas covers the whole window (so the glow never shows a square edge),
 * while `targetRef` marks where the orb should sit in the layout.
 *
 * Audio data is read from the `audioBus` inside the loop — never from React
 * state — so the visualization reacts to the real voice without re-rendering.
 *
 * When `animations` is off we paint a single static frame (repainted on resize
 * or phase change) instead of running a 60fps loop.
 */
export function useOrbVisualizer(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  targetRef: RefObject<HTMLElement | null>,
  options: OrbVisualizerOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const rendererRef = useRef<OrbRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const renderer = new OrbRenderer(canvas, ctx);
    rendererRef.current = renderer;

    const measure = () => {
      const dpr = window.devicePixelRatio || 1;
      const canvasRect = canvas.getBoundingClientRect();
      renderer.resize(canvasRect.width, canvasRect.height, dpr);

      const target = targetRef.current?.getBoundingClientRect();
      if (target && target.width > 0) {
        renderer.setGeometry(
          target.left + target.width / 2,
          target.top + target.height / 2,
          target.width * 0.3,
        );
      } else {
        renderer.resetCenter();
      }
    };

    const paint = (animations: boolean, dt = 0.016) => {
      renderer.render(
        performance.now() / 1000,
        dt,
        frameOptions(optionsRef.current, animations),
      );
    };

    measure();

    let last = 0;
    const stopLoop = options.animations
      ? runVisibleAnimationLoop(
          (timestamp) => {
            const t = timestamp / 1000;
            renderer.render(t, t - last, frameOptions(optionsRef.current, true));
            last = t;
            return true;
          },
          // Idle keeps half the rate: the orb is decoration then.
          { fps: optionsRef.current.phase === "idle" ? 30 : 60 },
        )
      : null;

    const observer = new ResizeObserver(() => {
      measure();
      if (!optionsRef.current.animations) paint(false);
    });
    observer.observe(canvas);
    if (targetRef.current) observer.observe(targetRef.current);
    window.addEventListener("resize", measure);

    if (!options.animations) paint(false);

    return () => {
      stopLoop?.();
      observer.disconnect();
      window.removeEventListener("resize", measure);
      rendererRef.current = null;
    };
  }, [canvasRef, targetRef, options.animations]);

  // No-animation mode has no loop, so repaint on state changes.
  useEffect(() => {
    if (optionsRef.current.animations) return;
    rendererRef.current?.render(
      performance.now() / 1000,
      0.016,
      frameOptions(optionsRef.current, false),
    );
  }, [options.phase, options.viz, options.accent]);
}