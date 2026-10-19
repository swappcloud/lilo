import { playChime } from "../lib/chime";
import { onEndSession, onPluginEvent, type PluginEvent } from "../lib/gateway";
import { logError } from "../lib/log";
import { isProviderId, providerMeta } from "../providers";
import { useSessionStore } from "./sessionStore";
import { toast } from "./toastStore";

export const NOTIFY_TOPIC = "notify";
const MAX_SUMMARY_CHARS = 300;

export interface NotifyHost {
  toast(text: string): void;
  chime(): void;
  canSpeak(): boolean;
  sendHidden(text: string): void;
}

export function handleNotify(host: NotifyHost, event: PluginEvent): boolean {
  if (event.topic !== NOTIFY_TOPIC) return false;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const raw = typeof payload.summary === "string" ? payload.summary : "";
  const summary = raw.replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY_CHARS);
  if (!summary) return false;
  host.toast(summary);
  if (payload.chime !== false) host.chime();
  if (payload.speak !== false && host.canSpeak()) {
    host.sendHidden(
      `A plugin reports: "${summary}". Tell the user in one short spoken sentence, in the language of the conversation.`,
    );
  }
  return true;
}

const desktopHost: NotifyHost = {
  toast,
  chime: playChime,
  canSpeak: () => {
    const { connectionState, providerId } = useSessionStore.getState();
    return (
      connectionState === "connected" &&
      isProviderId(providerId) &&
      providerMeta(providerId).protocol.outbound.text
    );
  },
  sendHidden: (text) => useSessionStore.getState().sendText(text, { hidden: true }),
};

export function startPluginNotifications(): () => void {
  let stopped = false;
  const offs: Array<() => void> = [];
  const keep = (off: () => void) => {
    if (stopped) off();
    else offs.push(off);
  };
  void onPluginEvent((event) => {
    try {
      handleNotify(desktopHost, event);
    } catch (error) {
      logError("notify", error);
    }
  }).then(keep);
  void onEndSession(() => useSessionStore.getState().endConversationByVoice()).then(keep);
  return () => {
    stopped = true;
    offs.forEach((off) => off());
  };
}
