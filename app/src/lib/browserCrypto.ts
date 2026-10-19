/** AES-GCM stays authenticated on LAN HTTP origins without SubtleCrypto. */
import { gcm } from "@noble/ciphers/aes.js";

export class BrowserCipher {
  private readonly native: Promise<CryptoKey> | null;
  private readonly subtle: SubtleCrypto | undefined;
  constructor(private readonly raw: Uint8Array<ArrayBuffer>) {
    this.subtle = globalThis.crypto?.subtle;
    this.native = this.subtle?.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]) ?? null;
  }
  async encrypt(iv: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>, associatedData: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    if (this.subtle && this.native) {
      return new Uint8Array(await this.subtle.encrypt({ name: "AES-GCM", iv, additionalData: associatedData }, await this.native, data));
    }
    return new Uint8Array(gcm(this.raw, iv, associatedData).encrypt(data));
  }
  async decrypt(iv: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>, associatedData: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    if (this.subtle && this.native) {
      return new Uint8Array(await this.subtle.decrypt({ name: "AES-GCM", iv, additionalData: associatedData }, await this.native, data));
    }
    return new Uint8Array(gcm(this.raw, iv, associatedData).decrypt(data));
  }
}

export function browserRequestId(): string {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
