import { useRef, type RefObject } from "react";

import type { CanvasVizMode, Rgb, VoicePhase } from "./orbRenderer";
import { useOrbVisualizer } from "./useOrbVisualizer";

interface Props {
  /** Where the orb sits in the layout. */
  targetRef: RefObject<HTMLElement | null>;
  phase: VoicePhase;
  energy: number;
  viz: CanvasVizMode;
  animations: boolean;
  accent: [Rgb, Rgb];
  music: boolean;
}

/**
 * The full-bleed canvas visualizers (orb, bars). Mounted only while one of
 * them is chosen, so the LILO character never pays for an idle canvas loop.
 */
export function OrbCanvas({ targetRef, ...options }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useOrbVisualizer(canvasRef, targetRef, options);
  return <canvas ref={canvasRef} className="orb-canvas" aria-hidden />;
}
