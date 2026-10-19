import { memo, useId, type Ref } from "react";

import {
  MARK_BODY_D,
  MARK_LOWER_WAVE_D,
  MARK_SPLIT_D,
  MARK_UPPER_WAVE_D,
} from "../../../shared/brand/logoPaths";

interface Props {
  svgRef?: Ref<SVGSVGElement>;
  className?: string;
}

/**
 * Static markup of the LILO character, starting as the logo. `LiloRenderer`
 * animates it by writing attributes on the `data-lilo` nodes; React never
 * re-renders it (the props it paints from never change).
 *
 * Ink is the accent gradient, so the character follows the accent setting.
 * The gradient is in user space: a flat waveform has a zero-height bounding
 * box, and a bounding-box gradient would not paint it at all.
 */
export const LiloFigure = memo(function LiloFigure({ svgRef, className }: Props) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const clipId = `lilo-split-${id}`;
  const inkId = `lilo-ink-${id}`;
  const ink = `url(#${inkId})`;
  return (
    <svg
      ref={svgRef}
      className={`lilo-figure${className ? ` ${className}` : ""}`}
      viewBox="0 0 400 400"
      aria-hidden
    >
      <defs>
        <linearGradient id={inkId} gradientUnits="userSpaceOnUse" x1="90" y1="70" x2="310" y2="330">
          <stop offset="0" className="lilo-stop-from" />
          <stop offset="1" className="lilo-stop-to" />
        </linearGradient>
        <clipPath id={clipId}>
          <path data-lilo="split" d={MARK_SPLIT_D} />
        </clipPath>
      </defs>
      <ellipse data-lilo="shadow" className="lilo-shadow" cx="200" cy="356" rx="92" ry="9" opacity="0" />
      <g data-lilo="tilt">
        <path data-lilo="body" className="lilo-paper" d={MARK_BODY_D} />
        <g clipPath={`url(#${clipId})`}>
          <path data-lilo="body" style={{ fill: ink }} d={MARK_BODY_D} />
        </g>
        <ellipse data-lilo="eye-left" style={{ fill: ink }} cx="150" cy="176" rx="0" ry="0" />
        <ellipse data-lilo="eye-right" className="lilo-paper" cx="250" cy="176" rx="0" ry="0" />
        <path data-lilo="brow-left" className="lilo-brow" style={{ stroke: ink }} d="" opacity="0" />
        <path data-lilo="brow-right" className="lilo-brow lilo-stroke-paper" d="" opacity="0" />
        <path data-lilo="mouth" className="lilo-mouth" style={{ fill: ink, stroke: ink }} d="" opacity="0" />
        <path data-lilo="wave" className="lilo-wave" style={{ stroke: ink }} d="" opacity="0" />
        <path data-lilo="wave-upper" className="lilo-wave lilo-stroke-paper" d={MARK_UPPER_WAVE_D} />
        <path data-lilo="wave-lower" className="lilo-wave" style={{ stroke: ink }} d={MARK_LOWER_WAVE_D} />
        <path data-lilo="body" className="lilo-outline" style={{ stroke: ink }} d={MARK_BODY_D} />
      </g>
    </svg>
  );
});
