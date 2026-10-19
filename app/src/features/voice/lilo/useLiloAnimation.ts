import { useEffect, useRef, type RefObject } from "react";

import { latestAudioFrame } from "../../../lib/audioBus";
import { musicLevels } from "../../../lib/musicLevels";
import { runVisibleAnimationLoop } from "../../../shared/lib/visibleRaf";
import { useMoodStore } from "../../../store/moodStore";
import type { VoicePhase } from "../orbRenderer";
import { claimLiloModel } from "./introHandoff";
import { LiloModel, type LiloInput } from "./liloModel";
import { pointerGaze } from "./pointerGaze";
import { LiloRenderer, voiceLevels } from "./liloRenderer";

export interface LiloAnimationOptions {
  phase: VoicePhase;
  animations: boolean;
  music: boolean;
}

function inputFor(options: LiloAnimationOptions): LiloInput {
  return {
    phase: options.phase,
    music: options.music,
    musicLevels: options.music ? musicLevels() : null,
    gaze: options.animations ? pointerGaze() : null,
    mood: useMoodStore.getState().mood,
    ...voiceLevels(options.phase, latestAudioFrame()),
  };
}

/**
 * Drives a `LiloFigure`. Audio is read from the bus inside the loop, never
 * from React state. With animations off it paints one settled pose per state
 * change instead of running a loop.
 */
export function useLiloAnimation(
  svgRef: RefObject<SVGSVGElement | null>,
  options: LiloAnimationOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const paintRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const renderer = new LiloRenderer(svg);
    let model = claimLiloModel() ?? new LiloModel();

    if (!options.animations) {
      paintRef.current = () => {
        model.settle(inputFor(optionsRef.current));
        renderer.draw(model.frame());
      };
      paintRef.current();
      return () => {
        paintRef.current = null;
      };
    }

    // Hidden windows stop animating, and idle motion runs at half rate: the
    // figure is decoration, and 60 fps here measured ~50% of a core.
    return runVisibleAnimationLoop(
      (now) => {
        // The splash hands over the model it played the intro with.
        const offered = claimLiloModel();
        if (offered) model = offered;
        model.step(now, inputFor(optionsRef.current));
        renderer.draw(model.frame());
        return true;
      },
      { fps: optionsRef.current.phase === "idle" ? 30 : 60 },
    );
  }, [svgRef, options.animations]);

  // No loop without animations: repaint when the pose should change.
  useEffect(() => {
    paintRef.current?.();
  }, [options.phase, options.music]);
}
