import { useId } from "react";

import {
  MARK_BODY_D,
  MARK_LOWER_WAVE_D,
  MARK_SPLIT_D,
  MARK_UPPER_WAVE_D,
  MARK_VIEWBOX,
} from "../brand/logoPaths";

interface LogoProps {
  size?: number;
  className?: string;
}

/** Below this size the source strokes fall under a device pixel. */
const SMALL = 64;

/**
 * LILO mark, from the vector logo. Ink is the accent gradient and paper follows
 * the theme (`--lilo-paper`). Colours go through `style`: CSS variables are not
 * valid in SVG presentation attributes.
 */
export function Logo({ size = 28, className }: LogoProps) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const clipId = `lilo-logo-split-${id}`;
  const inkId = `lilo-logo-ink-${id}`;
  const ink = `url(#${inkId})`;
  const paper = "var(--lilo-paper)";
  const small = size < SMALL;
  return (
    <svg
      aria-hidden
      className={className}
      width={size}
      height={size}
      viewBox={MARK_VIEWBOX}
      style={{ display: "inline-block", flex: "none", overflow: "visible" }}
    >
      <defs>
        <linearGradient id={inkId} gradientUnits="userSpaceOnUse" x1="90" y1="70" x2="310" y2="330">
          <stop offset="0" className="lilo-stop-from" />
          <stop offset="1" className="lilo-stop-to" />
        </linearGradient>
        <clipPath id={clipId}>
          <path d={MARK_SPLIT_D} />
        </clipPath>
      </defs>
      <path d={MARK_BODY_D} style={{ fill: paper }} />
      <path d={MARK_BODY_D} style={{ fill: ink }} clipPath={`url(#${clipId})`} />
      <g
        fill="none"
        strokeWidth={small ? 8 : 4.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={MARK_UPPER_WAVE_D} style={{ stroke: paper }} />
        <path d={MARK_LOWER_WAVE_D} style={{ stroke: ink }} />
      </g>
      <path
        d={MARK_BODY_D}
        fill="none"
        style={{ stroke: ink }}
        strokeWidth={small ? 14 : 8.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}
