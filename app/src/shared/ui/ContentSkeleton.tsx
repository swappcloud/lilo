/** Reserved content space while asynchronous settings data is loading. */
export function ContentSkeleton({ label, layout = "list" }: { label: string; layout?: "list" | "cards" }) {
  return <div className={`content-skeleton content-skeleton--${layout}`} role="status" aria-label={label}>
    {[0, 1].map((item) => <div className="content-skeleton-block" key={item} aria-hidden="true">
      <div className="content-skeleton-line content-skeleton-title" />
      <div className="content-skeleton-line" />
      <div className="content-skeleton-line content-skeleton-short" />
    </div>)}
  </div>;
}
