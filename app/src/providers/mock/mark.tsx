/**
 * The offline demo's mark: a level meter, drawn in `currentColor`.
 *
 * Not a vendor logo, but every backend declares one so the UI never needs a
 * "provider without an icon" branch.
 */
interface MarkProps {
  size?: number;
  className?: string;
}

export function MockMark({ size = 14, className }: MarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="4" y="10" width="3" height="4" rx="1.5" />
      <rect x="10.5" y="6" width="3" height="12" rx="1.5" />
      <rect x="17" y="9" width="3" height="6" rx="1.5" />
    </svg>
  );
}
