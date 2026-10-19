import type { Speaker } from "../../types";

/**
 * Tolerant parser for the ChatGPT web voice DataChannel (`oai-events`).
 *
 * Wire envelope:  { "type": "data_message", "data": "<json string>" }
 *
 * The inner schema is undocumented. The primary caption event is
 * `chat_message_delta`, whose text lives at `delta.v.message.content.parts`
 * with the role in `message.author.role` (or inferred from an
 * `audio_transcription` part's `direction`: `in` = user, `out` = assistant).
 * A second variant streams append operations:
 *   delta.v = [{ o: "append", p: "/message/content/parts/0/text", v: "…" }]
 *
 * Reference: https://github.com/dyhhhhhh/chatgpt-web-voice (`handleDcPayload`,
 * `applyCaptionDelta`).
 */

export type InboundKind =
  | "caption"
  | "message"
  | "speaking"
  | "stopped"
  | "usage"
  | "error"
  | "unknown";

export type TextMode = "replace" | "append";

export interface ParsedEvent {
  kind: InboundKind;
  speaker: Speaker;
  text: string;
  final: boolean;
  /** Snapshot vs. incremental append. */
  mode: TextMode;
  /** Stable id for a streamed message, when the protocol provides one. */
  messageId?: string;
  raw: unknown;
}

/** Recursively pull the most likely text payload out of an event object. */
export function extractText(value: unknown, depth = 0): string {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") return "";
  if (typeof value !== "object") return "";

  const obj = value as Record<string, unknown>;

  for (const key of ["delta", "text", "transcript", "caption"]) {
    const candidate = obj[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  const content = obj.content as Record<string, unknown> | undefined;
  if (content && typeof content === "object") {
    const parts = content.parts;
    if (Array.isArray(parts)) {
      const joined = parts.map(partText).filter(Boolean).join("\n");
      if (joined) return joined;
    }
    const nested = extractText(content, depth + 1);
    if (nested) return nested;
  }

  for (const key of ["payload", "message", "data", "item", "response", "delta"]) {
    const nested = extractText(obj[key], depth + 1);
    if (nested) return nested;
  }

  return "";
}

export function extractRole(value: unknown): Speaker {
  if (value == null || typeof value !== "object") return "assistant";
  const obj = value as Record<string, unknown>;

  const author = obj.author as Record<string, unknown> | undefined;
  const authorRole = author?.role;
  if (isSpeaker(authorRole)) return authorRole;

  const role = obj.role;
  if (isSpeaker(role)) return role;

  for (const key of ["payload", "message", "item", "delta"]) {
    const nested = extractRole(obj[key]);
    if (nested !== "assistant") return nested;
  }
  return "assistant";
}

function isSpeaker(value: unknown): value is Speaker {
  return value === "user" || value === "assistant" || value === "system";
}

function partText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const p = part as Record<string, unknown>;
  if (typeof p.text === "string") return p.text;
  if (typeof p.content === "string") return p.content;
  if (typeof p.transcript === "string") return p.transcript;
  return "";
}

interface DeltaText {
  role?: Speaker;
  text: string;
  messageId?: string;
  mode: TextMode;
}

/** Parse the two `delta` shapes produced by `chat_message_delta`. */
export function parseDelta(delta: unknown): DeltaText | null {
  if (!delta || typeof delta !== "object") return null;
  const d = delta as Record<string, unknown>;

  const message = (d.v as Record<string, unknown> | undefined)?.message as
    | Record<string, unknown>
    | undefined;

  if (message && typeof message === "object") {
    const content = message.content as Record<string, unknown> | undefined;
    const parts = Array.isArray(content?.parts) ? (content!.parts as unknown[]) : [];
    let role = (message.author as Record<string, unknown> | undefined)?.role;
    if (!isSpeaker(role)) {
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.content_type !== "audio_transcription") continue;
        if (p.direction === "in") role = "user";
        if (p.direction === "out") role = "assistant";
        break;
      }
    }
    if (!isSpeaker(role)) return null;
    const text = parts.map(partText).filter(Boolean).join("\n").trim();
    return {
      role,
      text,
      messageId: message.id ? String(message.id) : undefined,
      mode: "replace",
    };
  }

  if (Array.isArray(d.v)) {
    let appended = "";
    for (const op of d.v) {
      if (!op || typeof op !== "object") continue;
      const o = op as Record<string, unknown>;
      if (o.o !== "append") continue;
      if (!/^\/message\/content\/parts\/\d+\/text$/.test(String(o.p ?? ""))) continue;
      appended += String(o.v ?? "");
    }
    if (appended) return { text: appended, mode: "append" };
  }

  return null;
}

function extractTranscriptText(obj: Record<string, unknown>, payload: Record<string, unknown>): string {
  const candidates = [
    obj.transcript,
    obj.text,
    payload.transcript,
    payload.text,
    (payload.item as Record<string, unknown> | undefined)?.transcript,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return extractText(payload) || extractText(obj);
}

function classify(type: string): InboundKind {
  if (type.includes("chat_message_delta") || type.includes("delta")) return "caption";
  if (type.includes("relay_message") || type.includes("message")) return "message";
  if (type.includes("speaking")) return "speaking";
  if (type.includes("stop") || type.includes("done") || type.includes("completed")) {
    return "stopped";
  }
  if (type.includes("error")) return "error";
  return "unknown";
}

function isFinal(type: string, payload: Record<string, unknown>): boolean {
  if (payload.final === true || payload.is_final === true) return true;
  return (
    type.includes("completed") ||
    type.includes("done") ||
    type.includes("finished")
  );
}

function toEvent(item: unknown): ParsedEvent {
  const obj = (item ?? {}) as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "unknown";
  const payload =
    obj.payload && typeof obj.payload === "object"
      ? (obj.payload as Record<string, unknown>)
      : obj;

  // Assistant speaking / listening state drives barge-in and turn finalization.
  if (type === "state_update" || payload.type === "state_update") {
    const inner = (payload.payload ?? payload) as Record<string, unknown>;
    const state = String(inner.new_state ?? "");
    if (state === "speaking" || state === "responding") {
      return { kind: "speaking", speaker: "assistant", text: "", final: true, mode: "replace", raw: item };
    }
    if (state === "listening" || state === "idle") {
      return { kind: "stopped", speaker: "assistant", text: "", final: true, mode: "replace", raw: item };
    }
  }

  // Remaining voice budget (free accounts ~2h/day).
  if (type === "usage_update" || payload.type === "usage_update") {
    const usage = (payload.payload ?? payload) as Record<string, unknown>;
    const limits = usage.limits as Record<string, unknown> | undefined;
    const audio = usage.audio_s ?? (limits?.audio as Record<string, unknown> | undefined)?.remaining_seconds;
    return {
      kind: "usage",
      speaker: "system",
      text: audio != null ? String(audio) : "",
      final: true,
      mode: "replace",
      raw: item,
    };
  }

  if (type === "chat_message_delta" || payload.type === "chat_message_delta") {
    const delta =
      obj.delta ?? payload.delta ?? (payload.payload as Record<string, unknown> | undefined)?.delta;
    const parsed = parseDelta(delta);
    if (parsed) {
      return {
        kind: "caption",
        speaker: parsed.role ?? "assistant",
        text: parsed.text,
        final: false,
        mode: parsed.mode,
        messageId: parsed.messageId,
        raw: item,
      };
    }
  }

  if (type.includes("input_audio") && type.includes("transcription")) {
    return {
      kind: "caption",
      speaker: "user",
      text: extractTranscriptText(obj, payload),
      final: true,
      mode: "replace",
      raw: item,
    };
  }

  if (type.includes("audio_transcript")) {
    return {
      kind: "caption",
      speaker: "assistant",
      text: extractTranscriptText(obj, payload),
      final: isFinal(type, payload),
      mode: type.endsWith(".delta") ? "append" : "replace",
      messageId: typeof payload.item_id === "string" ? payload.item_id : undefined,
      raw: item,
    };
  }

  return {
    kind: classify(type),
    speaker: extractRole(obj),
    text: extractText(obj),
    final: isFinal(type, obj),
    mode: "append",
    raw: item,
  };
}

export function parseInbound(raw: string): ParsedEvent[] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return [];
  }
  if (envelope == null || typeof envelope !== "object") return [];

  const env = envelope as Record<string, unknown>;
  let payload: unknown = env;

  if (env.type === "data_message") {
    if (typeof env.data === "string") {
      try {
        payload = JSON.parse(env.data);
      } catch {
        return [];
      }
    } else {
      payload = env.data;
    }
  }

  if (payload == null || typeof payload !== "object") return [];

  const items = Array.isArray(payload) ? payload : [payload];
  return items.map(toEvent);
}
