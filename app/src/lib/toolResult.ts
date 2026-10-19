export function summaryOf(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const summary = (result as { summary?: unknown }).summary;
  return typeof summary === "string" && summary.trim() !== "" ? summary : null;
}
