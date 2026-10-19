import { isOwnerWindow } from "../app/windowRole";
import { isTauri, publishEvent } from "../lib/gateway";
import { logError } from "../lib/log";
import { isProviderId, providerMeta, type ProtocolCapabilities } from "../providers/contract";
import type { ConnectionState } from "../types";
import { resolveLanguage } from "./language";
import { usePreferencesStore } from "./preferencesStore";
import { useSessionStore } from "./sessionStore";

export interface PublicSessionContext {
  supportLanguage: string;
  sessionId: string | null;
  state: ConnectionState;
  provider: ProtocolCapabilities | null;
}

/** Construct the public contract explicitly; never spread provider/session data. */
export function publicSessionContext(
  state: { pluginSessionId: string | null; connectionState: ConnectionState },
  language: string,
  protocol: ProtocolCapabilities | null,
): PublicSessionContext {
  return {
    supportLanguage: resolveLanguage(language),
    sessionId: state.pluginSessionId,
    state: state.pluginSessionId ? state.connectionState : "idle",
    provider: protocol ? {
      inbound: {
        userText: protocol.inbound.userText, assistantText: protocol.inbound.assistantText,
        nativeToolCalls: protocol.inbound.nativeToolCalls, images: protocol.inbound.images,
      },
      outbound: {
        text: protocol.outbound.text, stopSpeaking: protocol.outbound.stopSpeaking,
        systemPrompt: protocol.outbound.systemPrompt, toolResult: protocol.outbound.toolResult,
        image: protocol.outbound.image,
      },
    } : null,
  };
}

/** Serial updates avoid a late publish replacing a newer connection state. */
export class SessionContextPublisher {
  private last = "";
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly publish: (topic: string, payload: unknown) => Promise<void>,
    private readonly report: (error: unknown) => void) {}

  update(context: PublicSessionContext): Promise<void> {
    const signature = JSON.stringify(context);
    if (signature === this.last) return this.queue;
    this.last = signature;
    this.queue = this.queue.then(() => this.publish("session.changed", context)).catch((error) => {
      this.last = "";
      this.report(error);
    });
    return this.queue;
  }
}

/** Only the voice owner supplies session metadata. */
export function startPluginSessionContext(): () => void {
  if (!isTauri() || !isOwnerWindow()) return () => {};
  const publisher = new SessionContextPublisher(publishEvent, (error) => logError("plugin-session", error));
  const push = () => {
    const state = useSessionStore.getState();
    const protocol = isProviderId(state.providerId) ? providerMeta(state.providerId).protocol : null;
    void publisher.update(publicSessionContext(state, usePreferencesStore.getState().language, protocol));
  };
  push();
  const session = useSessionStore.subscribe((state, previous) => {
    if (state.pluginSessionId !== previous.pluginSessionId || state.connectionState !== previous.connectionState ||
        state.providerId !== previous.providerId) push();
  });
  const preferences = usePreferencesStore.subscribe((state, previous) => {
    if (state.language !== previous.language) push();
  });
  return () => { session(); preferences(); };
}
