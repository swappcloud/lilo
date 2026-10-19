import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const aad = (direction) => Buffer.from(`lilo.browser.${direction}.v1`, "utf8");

export function seal(key, value, direction) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(direction));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString("base64"), data: body.toString("base64") };
}

export function open(key, envelope, direction) {
  if (!envelope || typeof envelope.iv !== "string" || typeof envelope.data !== "string" || envelope.data.length > 64000) throw new Error("Invalid envelope.");
  const iv = Buffer.from(envelope.iv, "base64");
  const body = Buffer.from(envelope.data, "base64");
  if (iv.length !== 12 || body.length < 16) throw new Error("Invalid envelope.");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad(direction));
  decipher.setAuthTag(body.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(body.subarray(0, -16)), decipher.final()]).toString("utf8"));
}

/** A bounded freshness window retains every accepted id until it expires. */
export class ReplayGuard {
  #seen = new Map();
  accept(message, now = Date.now()) {
    if (typeof message?.id !== "string" || message.id.length < 1 || message.id.length > 80 || !Number.isSafeInteger(message.timestamp) || Math.abs(now - message.timestamp) > 120000) throw new Error("Expired request.");
    for (const [id, timestamp] of this.#seen) if (now - timestamp > 120000) this.#seen.delete(id);
    if (this.#seen.has(message.id) || this.#seen.size >= 1024) throw new Error("Repeated or excessive request.");
    this.#seen.set(message.id, message.timestamp);
  }
}
