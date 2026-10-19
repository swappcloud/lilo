import type { TranscriptTurn } from "../../types";
import type { ProviderConversation } from "../types";

export function parseConversationHistory(raw: unknown, requestedId: string): { conversation: ProviderConversation; turns: TranscriptTurn[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.conversationId !== requestedId || !Array.isArray(value.turns)) return null;
  const conversation: ProviderConversation = { conversationId: requestedId };
  if (typeof value.parentMessageId === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value.parentMessageId)) conversation.parentMessageId = value.parentMessageId;
  const turns: TranscriptTurn[] = [];
  let chars = 0;
  for (const item of value.turns.slice(-200)) {
    if (!item || typeof item !== "object") continue;
    const turn = item as Record<string, unknown>;
    if (typeof turn.id !== "string" || turn.id.length > 200 || typeof turn.text !== "string" ||
      (turn.speaker !== "user" && turn.speaker !== "assistant") || typeof turn.timestamp !== "number" || !Number.isFinite(turn.timestamp)) continue;
    const text = turn.text.slice(0, 16_000);
    chars += text.length;
    if (chars > 96_000) break;
    turns.push({ id: turn.id, text, speaker: turn.speaker, timestamp: turn.timestamp, final: true });
  }
  return { conversation, turns };
}
