import type { TranscriptTurn } from "../types";

/** Merge the selected remote branch without discarding another provider's local turns. */
export function mergeConversationHistory(local: readonly TranscriptTurn[], remote: readonly TranscriptTurn[]): TranscriptTurn[] {
  const indexed = new Map(local.map((turn) => [turn.id, turn]));
  for (const turn of remote) indexed.set(turn.id, turn);
  return [...indexed.values()].sort((a, b) => a.timestamp - b.timestamp);
}
