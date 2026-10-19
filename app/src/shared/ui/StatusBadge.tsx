import type { ReactNode } from "react";

export type StatusTone = "neutral" | "positive" | "warning" | "negative";
const CLASSES: Record<StatusTone, string> = { neutral: "", positive: "ok", warning: "wait", negative: "bad" };

/** Short state labels only; explanations belong in the card body. */
export function StatusBadge({ children, tone = "neutral", title }: { children: ReactNode; tone?: StatusTone; title?: string }) {
  return <span className={`status-chip status-badge ${CLASSES[tone]}`.trim()} title={title}>{children}</span>;
}
