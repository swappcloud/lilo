import type { BrowserAction, BrowserFrame, BrowserPort } from "../../lib/browserPort";
import { BrowserCipher, browserRequestId } from "../../lib/browserCrypto";

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
function base64(value: ArrayBuffer | Uint8Array): string {
  const array = value instanceof Uint8Array ? value : new Uint8Array(value);
  let result = "";
  for (const byte of array) result += String.fromCharCode(byte);
  return btoa(result);
}

/** The pairing fragment supplies an independent key, never sent to the proxy. */
export class DaemonBrowser implements BrowserPort {
  providers: string[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private readonly cipher: BrowserCipher;
  constructor(keyHex: string, private readonly request: <T>(body: Record<string, unknown>) => Promise<T>) {
    if (!/^[a-f0-9]{64}$/.test(keyHex)) throw new Error("Invalid private pairing key.");
    const raw = Uint8Array.from(keyHex.match(/../g)!, byte => parseInt(byte, 16));
    this.cipher = new BrowserCipher(raw);
  }
  supports(provider: string): boolean { return this.providers.includes(provider); }
  exchange(action: BrowserAction): Promise<BrowserFrame> {
    const next = this.pending.catch(() => {}).then(() => this.send(action));
    this.pending = next;
    return next;
  }
  private async send(action: BrowserAction): Promise<BrowserFrame> {
    const id = browserRequestId();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await this.cipher.encrypt(iv, new TextEncoder().encode(JSON.stringify({ ...action, id, timestamp: Date.now() })), new TextEncoder().encode("lilo.browser.request.v1"));
    const envelope = await this.request<{iv: string; data: string}>({ operation: "browser", payload: { iv: base64(iv), data: base64(data) } });
    const decoded = await this.cipher.decrypt(bytes(envelope.iv), bytes(envelope.data), new TextEncoder().encode("lilo.browser.response.v1"));
    const frame = JSON.parse(new TextDecoder().decode(decoded)) as BrowserFrame & {id: string};
    if (frame.id !== id || !["login", "connected", "closed", "error", "audio"].includes(frame.phase)) throw new Error("Invalid browser response.");
    if (frame.image && (!/^[A-Za-z0-9+/=]+$/.test(frame.image) || frame.image.length > 400000 || frame.width !== 430 || frame.height !== 740)) throw new Error("Invalid browser image.");
    return frame;
  }
}
