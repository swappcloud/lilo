import { isOwnerWindow } from "../app/windowRole";
import { isTauri, onPluginEvent, publishEvent, type PluginEvent } from "../lib/gateway";
import { logError } from "../lib/log";
import { useSessionStore } from "./sessionStore";

export interface QuestionSubmissionHost {
  submit(sessionId: string, prompt: string): boolean;
  publish(topic: string, payload: unknown): Promise<void>;
  now(): number;
}

/** Submission is not proof that the adapter or the user heard the question. */
export async function submitInteractionQuestion(host: QuestionSubmissionHost, event: PluginEvent): Promise<void> {
  if (event.source !== "host" || event.topic !== "interaction.requested") return;
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload || typeof payload.id !== "string" || payload.id.length > 128 ||
      typeof payload.deliveryId !== "string" || payload.deliveryId.length > 128 ||
      typeof payload.sessionId !== "string" || payload.sessionId.length > 128 ||
      typeof payload.prompt !== "string" || !payload.prompt.trim() || payload.prompt.length > 2000 ||
      typeof payload.expiresAt !== "number" || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= host.now()) return;
  let status: "submitted" | "unsupported" | "failed";
  try {
    status = host.submit(payload.sessionId, payload.prompt) ? "submitted" : "unsupported";
  } catch { status = "failed"; }
  await host.publish("interaction.delivery", {id:payload.id,deliveryId:payload.deliveryId,sessionId:payload.sessionId,status});
}

export function startPluginInteractions(): () => void {
  if (!isTauri() || !isOwnerWindow()) return () => {};
  let stopped = false;
  let off: (() => void) | undefined;
  const host: QuestionSubmissionHost = {
    submit: (sessionId,prompt) => useSessionStore.getState().submitPluginQuestion(sessionId,prompt),
    publish: publishEvent, now: Date.now,
  };
  void onPluginEvent((event) => {
    if (!stopped) void submitInteractionQuestion(host,event).catch((error) => logError("plugin-question",error));
  }).then((unlisten) => { if (stopped) unlisten(); else off = unlisten; })
    .catch((error) => logError("plugin-question-listener",error));
  return () => { stopped = true; off?.(); };
}
