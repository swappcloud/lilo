/**
 * Pictures ChatGPT makes in a voice conversation.
 *
 * The data channel carries the conversation's messages; a generated picture is
 * a non-user message part `{ content_type: "image_asset_pointer",
 * asset_pointer: "sediment://file_…" }` (older ones: `file-service://file-…`),
 * often with its prompt in `metadata`. Only the file id is read here; the host
 * downloads the bytes with the account's own session (`chatgpt_generated_image`).
 */

export interface FoundImage {
  fileId: string;
  conversationId?: string;
  prompt: string;
  width?: number;
  height?: number;
}

const POINTER = /^(?:sediment|file-service):\/\/(file[-_][A-Za-z0-9_-]{4,})$/;
const MAX_DEPTH = 12;

type Node = Record<string, unknown>;
const asNode = (value: unknown): Node | null =>
  value && typeof value === "object" ? (value as Node) : null;

/** Read explicit percentages in image-generation events, never estimate one. */
export function findImageProgress(payload: unknown): number | null {
  let percent: number | null = null;
  const read = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) percent = value;
  };
  const walk = (value: unknown, imageContext: boolean, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      value.forEach((child) => walk(child, imageContext, depth + 1));
      return;
    }
    const node = asNode(value);
    if (!node || asNode(node.author)?.role === "user") return;
    const context = imageContext || [node.type, node.name, asNode(node.author)?.name]
      .some((kind) => typeof kind === "string" && /^(?:image_gen|image_generation)(?:[._]|$)/.test(kind));
    if (context) {
      for (const key of ["percentage", "percent", "progress_percent", "progress_percentage"]) read(node[key]);
    }
    for (const [key, child] of Object.entries(node)) {
      if (child && typeof child === "object") {
        walk(child, context || key === "image_gen_progress" || key === "image_generation_progress", depth + 1);
      }
    }
  };
  walk(payload, false, 0);
  return percent;
}

/** The payload inside the `data_message` envelope, or the frame itself. */
export function innerPayload(raw: string): unknown {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  const envelope = asNode(frame);
  if (envelope?.type === "data_message" && typeof envelope.data === "string") {
    try {
      return JSON.parse(envelope.data);
    } catch {
      return null;
    }
  }
  return frame;
}

function promptOf(part: Node, message: Node | null): string {
  const metadata = asNode(part.metadata);
  const sources = [
    asNode(metadata?.dalle)?.prompt,
    asNode(metadata?.generation)?.prompt,
    metadata?.prompt,
    asNode(message?.metadata)?.image_gen_title,
  ];
  const prompt = sources.find((value) => typeof value === "string" && value.trim());
  return typeof prompt === "string" ? prompt.trim().slice(0, 500) : "";
}

/** Every picture a non-user message carries, wherever the payload nests it. */
export function findGeneratedImages(payload: unknown): FoundImage[] {
  const found = new Map<string, FoundImage>();
  let conversationId: string | undefined;

  const walk = (value: unknown, message: Node | null, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, message, depth + 1);
      return;
    }
    const node = asNode(value);
    if (!node) return;
    if (!conversationId && typeof node.conversation_id === "string") conversationId = node.conversation_id;
    // A message is what carries `author`; its parts inherit who wrote it.
    const owner = asNode(node.author) ? node : message;
    const pointer = typeof node.asset_pointer === "string" ? POINTER.exec(node.asset_pointer) : null;
    const role = asNode(owner?.author)?.role;
    if (pointer && node.content_type === "image_asset_pointer" && role !== "user" && !found.has(pointer[1])) {
      const size = (key: string) => (typeof node[key] === "number" && (node[key] as number) > 0 ? (node[key] as number) : undefined);
      found.set(pointer[1], { fileId: pointer[1], prompt: promptOf(node, owner), width: size("width"), height: size("height") });
    }
    for (const child of Object.values(node)) {
      if (child && typeof child === "object") walk(child, owner, depth + 1);
    }
  };

  walk(payload, null, 0);
  return [...found.values()].map((image) => ({ ...image, conversationId }));
}

/**
 * A content-free outline of a payload (its type, roles and part types), so the
 * log can show which shapes arrive without recording what anyone said.
 */
export function payloadShape(payload: unknown): string {
  const node = asNode(payload);
  const kinds = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (depth > MAX_DEPTH) return;
    const item = asNode(value);
    if (!item) return;
    if (typeof item.content_type === "string") kinds.add(`part:${item.content_type}`);
    const role = asNode(item.author)?.role;
    if (typeof role === "string") kinds.add(`role:${role}`);
    for (const child of Object.values(item)) if (child && typeof child === "object") walk(child, depth + 1);
  };
  walk(payload, 0);
  const type = typeof node?.type === "string" ? node.type : "?";
  return [type, ...[...kinds].sort()].join(" ").slice(0, 200);
}
