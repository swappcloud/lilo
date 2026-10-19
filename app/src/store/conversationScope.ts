interface ScopedConversation {
  id: string;
  providerId?: string;
  turns: readonly unknown[];
  updatedAt: number;
  sessions?: Record<string, unknown>;
  threads?: Record<string, unknown>;
}

/** Old mixed histories remain readable but never become a new provider's context. */
export function conversationProvider(conversation: ScopedConversation): string | undefined {
  if (conversation.providerId) return conversation.providerId;
  const providers = new Set([...Object.keys(conversation.sessions ?? {}), ...Object.keys(conversation.threads ?? {})]);
  return providers.size === 1 ? [...providers][0] : undefined;
}

export function conversationForProvider<T extends ScopedConversation>(conversations: readonly T[], activeId: string, provider: string): T | undefined {
  const active = conversations.find((conversation) => conversation.id === activeId);
  if (active && (conversationProvider(active) === provider || (!conversationProvider(active) && active.turns.length === 0))) return active;
  return conversations.filter((conversation) => conversationProvider(conversation) === provider)
    .reduce<T | undefined>((latest, conversation) => !latest || conversation.updatedAt > latest.updatedAt ? conversation : latest, undefined);
}
