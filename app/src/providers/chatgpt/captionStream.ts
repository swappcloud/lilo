import type { TranscriptTurn } from "../../types";
import { newTurn, turnWithId } from "../types";
import type { ParsedEvent } from "./events";

/** Assemble snapshots and role-less append deltas into stable transcript turns. */
export function advanceCaption(previous: TranscriptTurn | null, event: ParsedEvent) {
  const speaker = event.mode === "append" && !event.messageId
    ? previous?.speaker ?? event.speaker
    : event.speaker;
  const changed = previous && ((event.messageId && previous.id !== event.messageId)
    || (event.mode === "replace" && previous.speaker !== speaker));
  const finalized = changed ? { ...previous, final: true } : null;
  const current = changed ? null : previous;
  const id = event.messageId ?? current?.id ?? newTurn(speaker, "", false).id;
  const base = current?.id === id ? current : turnWithId(id, speaker);
  const turn: TranscriptTurn = {
    ...base,
    text: event.mode === "append" ? base.text + event.text : event.text,
    final: event.final,
  };
  return { finalized, turn, partial: event.final ? null : turn };
}
