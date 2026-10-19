import { afterEach, describe, expect, it } from "vitest";
import grok from "../../../../src-tauri/src/providers/grok.rs?raw";
import rawSource from "../../../../packages/phone-login/driver.js?raw";

const source = rawSource.replace(/\r\n/g, "\n");

// Exercise the injected predicate with the DOM states returned by login pages.
const start = source.indexOf("const challenge = () =>");
const end = source.indexOf("\n  //", start);
function challenge(): boolean {
  const predicate = source.slice(start, end);
  return new Function("document", "visible", `${predicate} return challenge();`)(
    document, (el: Element | null) => !!el && el.getClientRects().length > 0,
  );
}
afterEach(() => { document.body.innerHTML = ""; document.title = ""; });
describe("phone login challenges", () => {
  it("allows the email form when an invisible Turnstile response field exists", () => {
    document.body.innerHTML = '<input type="email"><input type="hidden" name="cf-turnstile-response">';
    expect(challenge()).toBe(false);
  });
  it("ignores an invisible automatic Turnstile iframe", () => {
    document.body.innerHTML = '<iframe src="https://challenges.cloudflare.com/turnstile"></iframe>';
    expect(challenge()).toBe(false);
  });
  it("still detects a Cloudflare interstitial", () => {
    document.title = "Just a moment...";
    expect(challenge()).toBe(true);
  });
  it("detects a compact visible Turnstile checkbox after submission", () => {
    const frame = document.createElement("iframe");
    frame.src = "https://challenges.cloudflare.com/turnstile";
    frame.getClientRects = () => [new DOMRect(0, 0, 300, 65)] as unknown as DOMRectList;
    frame.getBoundingClientRect = () => new DOMRect(0, 0, 300, 65);
    document.body.append(frame);
    expect(challenge()).toBe(true);
  });
  it("ignores a one-pixel automatic verification iframe", () => {
    const frame = document.createElement("iframe");
    frame.src = "https://challenges.cloudflare.com/turnstile";
    frame.getClientRects = () => [new DOMRect(0, 0, 1, 1)] as unknown as DOMRectList;
    frame.getBoundingClientRect = () => new DOMRect(0, 0, 1, 1);
    document.body.append(frame);
    expect(challenge()).toBe(false);
  });
  it("detects a visible interactive challenge", () => {
    const frame = document.createElement("iframe");
    frame.src = "https://challenges.cloudflare.com/turnstile";
    frame.getClientRects = () => [new DOMRect(0, 0, 300, 200)] as unknown as DOMRectList;
    frame.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200);
    document.body.append(frame);
    expect(challenge()).toBe(true);
  });
});

describe("Grok email entry", () => {
  const pattern = JSON.parse(grok.match(/entry_text:\s*("[^\n]+")\s*,/)![1]) as string;
  it.each(["Continue with email", "Login with email", "Log in with email", "Sign in with email"])("opens %s", (label) => {
    expect(new RegExp(pattern, "i").test(label)).toBe(true);
  });
  it.each(["Login with Google", "Login with Apple", "Login with X", "Sign up with email"])("does not open %s", (label) => {
    expect(new RegExp(pattern, "i").test(label)).toBe(false);
  });
});

describe("phone login landing states", () => {
  const begin = source.indexOf("  if (!ask) {\n    // A landing screen:");
  const corrected = source.indexOf("  if (!ask) {\n    if (challenge())");
  const offset = corrected >= 0 ? corrected : begin;
  const block = source.slice(offset, source.indexOf("\n  const ran =", offset));
  function probe(hasChallenge: boolean): Array<Record<string, string>> {
    const reports: Array<Record<string, string>> = [];
    new Function("ask", "challenge", "entry", "entryPattern", "find", "document", "visible", "window", "trace", "setTimeout", "report", block)(
      null, () => hasChallenge, "", null, () => null, document, () => false,
      { __liloPhoneBlank: Date.now() - 11000 }, () => {}, (fn: () => void) => fn(),
      (value: Record<string, string>) => reports.push(value),
    );
    return reports;
  }
  it("does not label an unrecognized page as a verified captcha", () => {
    expect(probe(false)).toEqual([{ step: "challenge", message: "page-unrecognized" }]);
  });
  it("reports an actual challenge separately", () => {
    expect(probe(true)).toEqual([{ step: "challenge" }]);
  });
});
