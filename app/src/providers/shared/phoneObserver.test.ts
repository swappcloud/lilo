import { describe, expect, it, vi } from "vitest";
import source from "../../../../packages/phone-login/observer.js?raw";

function observe(fetch: typeof globalThis.fetch) {
  const window = { fetch, __liloPhoneObserver: undefined as undefined | {
    active: boolean; requests: number; pending: number; status: number; failures: number;
    submits: number; invalid: number;
  } };
  const page = document.implementation.createHTMLDocument();
  new Function("window", "document", "XMLHttpRequest", source)(window, page, undefined);
  return { window, page, state: window.__liloPhoneObserver! };
}

describe("phone submission observation", () => {
  it("forwards the exact request and response without reading credentials", async () => {
    const response = { status: 200, get body(): never { throw new Error("Do not inspect responses"); } } as unknown as Response;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const { window, state } = observe(fetch); state.active = true;
    const options = { method: "POST", get body(): never { throw new Error("Do not inspect credentials"); } };
    const result = window.fetch("https://accounts.x.ai/verify", options);
    expect(state.pending).toBe(1);
    expect(await result).toBe(response);
    expect(fetch.mock.calls[0][1]).toBe(options);
    expect(state).toMatchObject({ requests: 1, pending: 0, status: 200, failures: 0 });
    expect(JSON.stringify(state)).not.toContain("accounts.x.ai");
  });
  it("preserves network errors while recording that the request finished", async () => {
    const error = new TypeError("Network unavailable");
    const { window, state } = observe(vi.fn<typeof globalThis.fetch>().mockRejectedValue(error)); state.active = true;
    await expect(window.fetch("/verify", { method: "POST" })).rejects.toBe(error);
    expect(state).toMatchObject({ requests: 1, pending: 0, status: 0, failures: 1 });
  });
  it("records HTTP rejections without consuming their response body", async () => {
    const response = { status: 401 } as Response;
    const { window, state } = observe(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)); state.active = true;
    expect(await window.fetch("/verify", { method: "POST" })).toBe(response);
    expect(state).toMatchObject({ status: 401, failures: 1 });
  });
  it("leaves requests unchanged while phone login is inactive", () => {
    const request = Promise.resolve({ status: 200 } as Response);
    const { window, state } = observe(vi.fn<typeof globalThis.fetch>().mockReturnValue(request));
    expect(window.fetch("/verify", { method: "POST" })).toBe(request);
    expect(state.requests).toBe(0);
  });
  it("distinguishes browser validation failures from form submission", () => {
    const { page, state } = observe(vi.fn<typeof globalThis.fetch>()); state.active = true;
    page.body.innerHTML = '<form><input required><button>Log in</button></form>';
    page.querySelector("button")!.click();
    expect(state.invalid).toBe(1); expect(state.submits).toBe(0);
    page.querySelector("input")!.value = "test";
    page.querySelector("form")!.addEventListener("submit", event => event.preventDefault());
    page.querySelector("button")!.click();
    expect(state.submits).toBe(1);
  });
});
