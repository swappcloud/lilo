import type { ReactNode } from "react";

/** Every card uses the same title, metadata and right-hand status slots. */
export function CardHeader({ title, description, status, controls }: { title: ReactNode; description?: ReactNode; status?: ReactNode; controls?: ReactNode }) {
  return <div className="card-header">
    <div className="card-header-copy"><div className="card-header-title">{title}</div>{description && <div className="card-header-description">{description}</div>}</div>
    {(status || controls) && <div className="card-header-trailing">{status}{controls}</div>}
  </div>;
}
