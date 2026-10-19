import type { ProviderConversation } from "../types";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}
function id(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : undefined;
}

/** Only authoritative thread events bind a local conversation to a remote chat. */
export function conversationUpdate(raw: unknown, previous?: ProviderConversation): ProviderConversation | undefined {
  const root = object(raw);
  if (!root) return;
  const event = object(root.payload)?.type ? object(root.payload)! : root;
  if (event.type !== "startup_telemetry" && event.type !== "conversation_update") return;
  const value = object(event.payload) ?? event;
  const conversationId = id(value.conversation_id) ?? previous?.conversationId;
  if (!conversationId) return;
  const parentMessageId = id(value.parent_message_id) ??
    (conversationId === previous?.conversationId ? previous.parentMessageId : undefined);
  return { conversationId, ...(parentMessageId ? { parentMessageId } : {}) };
}

/** Quota, network and authentication failures must never split a conversation. */
export function conversationIsFull(raw: unknown): boolean {
  const root = object(raw);
  if (!root) return false;
  const event = object(root.payload)?.type ? object(root.payload)! : root;
  if (event.type !== "error") return false;
  const value = object(event.error) ?? object(event.payload) ?? event;
  const code = object(value.error)?.code ?? value.code;
  return code === "context_length_exceeded" || code === "conversation_limit_exceeded";
}

export function conversationEvents(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [raw];
}
