/**
 * DataChannel (`oai-events`) wire protocol for the ChatGPT web voice path.
 *
 * Every outbound event **must** be wrapped in the `data_message` envelope whose
 * `data` field is itself a JSON *string* — this is what the official transceiver
 * expects. Omitting the wrapper (a previous bug) makes the server silently
 * ignore the event, which is why the interrupt button appeared to do nothing.
 *
 * Reference: https://github.com/dyhhhhhh/chatgpt-web-voice (`sendDcEventTo`)
 */

import type { SharedImage } from "../types";

export interface RelayMessageOptions {
  id: string;
  createTime: number;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Wrap any event object in the mandatory `data_message` envelope. */
export function wrapDataMessage(event: unknown): string {
  return JSON.stringify({
    type: "data_message",
    data: JSON.stringify(event),
  });
}

/** Barge-in / manual interrupt. */
export function buildStopSpeaking(): string {
  return wrapDataMessage({
    type: "action_request",
    payload: { action: "stop_speaking" },
  });
}

/** In-call typed text turn. */
export function buildRelayMessage(
  text: string,
  options?: Partial<RelayMessageOptions>,
): string {
  const id = options?.id ?? uuid();
  const createTime = options?.createTime ?? Date.now() / 1000;
  return wrapDataMessage({
    type: "relay_message",
    payload: {
      type: "relay_message",
      message: {
        id,
        author: { role: "user" },
        create_time: createTime,
        content: { content_type: "text", parts: [text] },
        metadata: { serialization_metadata: { custom_symbol_offsets: [] } },
        clientMetadata: { isOptimistic: true },
      },
    },
  });
}

/**
 * In-call image reference (`sediment://<file_id>`).
 *
 * Shaped exactly like the web client's: the text part is a bare string, the
 * pointer carries its byte size and pixel size, and the file is listed again
 * under `metadata.attachments`. A text part wrapped as `{content_type, text}`
 * is not a valid part, and the server drops the whole message without a word.
 */
export function buildRelayImage(image: SharedImage, text: string): string {
  const parts: unknown[] = [
    {
      content_type: "image_asset_pointer",
      asset_pointer: `sediment://${image.fileId}`,
      size_bytes: image.size,
      width: image.width,
      height: image.height,
    },
  ];
  if (text.trim()) parts.push(text.trim());
  return wrapDataMessage({
    type: "relay_message",
    payload: {
      type: "relay_message",
      message: {
        id: uuid(),
        author: { role: "user" },
        create_time: Date.now() / 1000,
        content: { content_type: "multimodal_text", parts },
        metadata: {
          serialization_metadata: { custom_symbol_offsets: [] },
          attachments: [
            {
              id: image.fileId,
              size: image.size,
              name: image.name,
              mimeType: image.mime,
              width: image.width,
              height: image.height,
            },
          ],
        },
        clientMetadata: { isOptimistic: true },
      },
    },
  });
}