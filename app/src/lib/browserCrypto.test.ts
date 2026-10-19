import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserCipher, browserRequestId } from "./browserCrypto";

const secureRandom = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
const hex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], byte => parseInt(byte, 16));

afterEach(() => vi.unstubAllGlobals());
describe("LAN HTTP browser encryption", () => {
  it("interoperates with host AES-GCM without SubtleCrypto and rejects altered packets", async () => {
    vi.stubGlobal("crypto", { getRandomValues: secureRandom });
    const key = new Uint8Array(32);
    const iv = new Uint8Array(12);
    const aad = new TextEncoder().encode("lilo.browser.request.v1");
    const data = new TextEncoder().encode("test payload");
    const cipher = new BrowserCipher(key);
    // NIST AES-256-GCM known-answer vector, including the 128-bit authentication tag.
    const vector = hex("cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919");
    const zeroBlock = new Uint8Array(16);
    const empty = new Uint8Array(0);
    expect(Array.from(await cipher.encrypt(iv, zeroBlock, empty))).toEqual(Array.from(vector));
    expect(Array.from(await cipher.decrypt(iv, vector, empty))).toEqual(Array.from(zeroBlock));
    const encrypted = await cipher.encrypt(iv, data, aad);
    expect(Array.from(await cipher.decrypt(iv, encrypted, aad))).toEqual(Array.from(data));
    const tampered = new Uint8Array(encrypted);
    tampered[0] ^= 1;
    await expect(cipher.decrypt(iv, tampered, aad)).rejects.toThrow();
    await expect(cipher.decrypt(iv, encrypted, new TextEncoder().encode("wrong context"))).rejects.toThrow();
  });
  it("generates secure request IDs when HTTP hides randomUUID", () => {
    vi.stubGlobal("crypto", { getRandomValues: secureRandom });
    const id = browserRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(browserRequestId()).not.toBe(id);
  });
});
