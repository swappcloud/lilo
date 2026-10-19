import { useEffect, useRef } from "react";

import { watchConversationMood } from "../../../store/moodContext";
import { startMood } from "../../../store/moodStore";
import { phaseAccent, publishAccentVars, type Rgb, type VoicePhase } from "../orbRenderer";
import { LiloFigure } from "./LiloFigure";
import { watchPointerGaze } from "./pointerGaze";
import { useLiloAnimation } from "./useLiloAnimation";

interface Props {
  phase: VoicePhase;
  animations: boolean;
  music: boolean;
  accent: [Rgb, Rgb];
}

/** The LILO character on the voice stage. */
export function LiloStage({ phase, animations, music, accent }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  useLiloAnimation(svgRef, { phase, animations, music });

  // The eyes follow the pointer anywhere in the window. Only while animating:
  // with animations off there is no loop to pick the gaze up.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !animations) return;
    return watchPointerGaze(svg);
  }, [animations]);

  // Owner-window only: the panel window never renders `LiloStage`.
  useEffect(() => startMood(), []);
  useEffect(() => watchConversationMood(), []);

  // The canvas renderer normally publishes the glow colours captions and pills
  // use; without it they would stay on the default accent.
  useEffect(() => {
    const [c1, c2] = phaseAccent(phase, accent);
    publishAccentVars(c1, c2);
  }, [phase, accent]);

  return <LiloFigure svgRef={svgRef} className="lilo-stage" />;
}
