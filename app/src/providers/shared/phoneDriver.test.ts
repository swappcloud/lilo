import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState, type ChangeEvent } from "react";
import { createRoot } from "react-dom/client";
import grok from "../../../../src-tauri/src/providers/grok.rs?raw";
import source from "../../../../packages/phone-login/driver.js?raw";

const template = source;
afterEach(() => { vi.restoreAllMocks(); Reflect.deleteProperty(document, "execCommand"); document.body.innerHTML = ""; document.title = ""; });
function driver(field: string | null, value: string, codeSwitch = "one-time code|c[oó]digo|codice", host = "auth.openai.com", traceAt = Date.now(), entryText = "", codeInputs = "") {
  const reports: Array<Record<string, unknown>> = [];
  const callbacks: Array<{ fn: () => void; delay: number }> = [];
  const storage = new Map<string, string>();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return (this.closest("[hidden]") || (this as HTMLInputElement).type === "hidden" ? [] : [new DOMRect(0, 0, 300, 65)]) as unknown as DOMRectList;
  });
  const sessionStorage = { getItem: (key: string) => storage.get(key), setItem: (key: string, val: string) => storage.set(key, val) };
  const location = {
    host, pathname: "/email-verification", href: "",
    set report(url: string) { reports.push(JSON.parse(atob(url.split("#")[1]))); },
  };
  Object.defineProperty(location, "href", { set: (url: string) => { location.report = url; } });
  const window = { location, __liloPhoneTrace: traceAt };
  const script = template
    .replaceAll("__FIELD__", JSON.stringify(field)).replaceAll("__VALUE__", JSON.stringify(value))
    .replaceAll("__ATTEMPT__", "1").replaceAll("__ENTRY_TEXT__", JSON.stringify(entryText)).replaceAll("__ENTRY__", '""')
    .replaceAll("__CODE_SWITCH__", JSON.stringify(codeSwitch))
    .replaceAll("__CODE_INPUTS__", JSON.stringify(codeInputs))
    .replaceAll("__PHONE_SWITCH__", '""');
  new Function("window", "document", "location", "sessionStorage", "history", "setTimeout", "HTMLInputElement", "HTMLSelectElement", "Event", "KeyboardEvent", "TextEncoder", script)(
    window, document, location, sessionStorage, { back: vi.fn() },
    (fn: () => void, delay: number) => callbacks.push({ fn, delay }),
    HTMLInputElement, HTMLSelectElement, Event, KeyboardEvent, TextEncoder,
  );
  return { reports, window, callbacks, run: (delay: number) => {
    const index = callbacks.findIndex((item) => item.delay === delay);
    expect(index).toBeGreaterThanOrEqual(0);
    callbacks.splice(index, 1)[0].fn();
  } };
}
describe("phone form submission", () => {
  it("opens a provider login form through its declared entry label", () => {
    document.body.innerHTML = '<button id="login">Log in</button>';
    const button = document.querySelector<HTMLButtonElement>("#login")!;
    const clicked = vi.fn(() => { document.body.innerHTML = '<form><input type="email"><button>Continue</button></form>'; });
    button.addEventListener("click", clicked);
    const entryText = "^log in$";
    driver(null, "", "", "fixture.invalid", Date.now(), entryText);
    expect(clicked).toHaveBeenCalledOnce();
    // The native poll evaluates the driver again after the entry navigation.
    const flow = driver(null, "", "", "fixture.invalid", Date.now(), entryText);
    expect(flow.reports).toContainEqual(expect.objectContaining({ step: "ask", ask: "email" }));
  });
  it("records form counts and loading state without account labels or page addresses", () => {
    document.body.innerHTML = '<form><input type="search" name="private@example.com" placeholder="Personal account"><button>Private conversation</button></form>';
    const flow = driver(null, "", "", "auth.openai.com", 0);
    const trace = flow.reports.find((report) => report.step === "trace");
    expect(trace).toBeDefined();
    expect(trace!.message).toContain("inputs=1");
    expect(trace!.message).not.toContain("private@example.com");
    expect(trace!.message).not.toContain("Personal account");
    expect(trace!.message).not.toContain("Private conversation");
    expect(trace!.message).not.toContain("auth.openai.com");
  });
  it("waits for the provider page without driving the initial blank document", () => {
    document.body.innerHTML = "";
    const flow = driver(null, "", "", "");
    expect(flow.reports).toEqual([]);
    expect(flow.callbacks).toEqual([]);
    expect(flow.window).not.toHaveProperty("__liloPhoneAttempt");
  });
  it("commits a code through browser editing when synthetic input leaves the vendor state empty", () => {
    document.body.innerHTML = '<form><input name="code" autocomplete="one-time-code"><button>Log in</button></form>';
    const input = document.querySelector("input")!;
    let committedCode = "";
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn((command, _ui, value) => {
      expect(command).toBe("insertText"); expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(input.value.length);
      input.value = value; committedCode = value; return true;
    }) });
    const submitted = vi.fn();
    document.querySelector("form")!.addEventListener("submit", event => { event.preventDefault(); submitted(committedCode); });
    const flow = driver("code", "123456"); flow.run(300);
    expect(submitted).toHaveBeenCalledWith("123456");
  });
  it("submits the code held by a React-controlled OTP form", () => {
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    const submitted = vi.fn();
    function Form() {
      const [code, setCode] = useState("");
      return createElement("form", { onSubmit: (event) => { event.preventDefault(); submitted(code); } },
        createElement("input", { name: "code", autoComplete: "one-time-code", value: code, maxLength: 6,
          onChange: (event: ChangeEvent<HTMLInputElement>) => setCode(event.currentTarget.value) }),
        createElement("button", { type: "submit", disabled: code.length !== 6 }, "Log in"));
    }
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(Form)));
      let flow!: ReturnType<typeof driver>;
      act(() => { flow = driver("code", "123456"); });
      act(() => flow.run(300));
      expect(submitted).toHaveBeenCalledWith("123456");
    } finally { act(() => root.unmount()); environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; }
  });
  it("fills six React-controlled OTP digit fields", () => {
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    const submitted = vi.fn();
    function Form() {
      const [digits, setDigits] = useState(["", "", "", "", "", ""]);
      return createElement("form", { onSubmit: (event) => { event.preventDefault(); submitted(digits.join("")); } },
        ...digits.map((digit, index) => createElement("input", {
          key: index, "aria-label": `Verification code digit ${index + 1}`, value: digit, maxLength: 1,
          onChange: (event: ChangeEvent<HTMLInputElement>) => {
            const value = event.currentTarget.value;
            setDigits(current => current.map((digitValue, slot) => slot === index ? value : digitValue));
          },
        })),
        createElement("button", { type: "submit", disabled: digits.some(digit => !digit) }, "Continue"));
    }
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(Form)));
      let flow!: ReturnType<typeof driver>;
      act(() => { flow = driver("code", "123456", "", "fixture.invalid", Date.now(), "", 'input[aria-label^="Verification code digit"]'); });
      act(() => flow.run(300));
      act(() => flow.run(800));
      expect(submitted).toHaveBeenCalledWith("123456");
    } finally { act(() => root.unmount()); environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; }
  });
  it("asks for email first when Grok displays email and password together", () => {
    document.body.innerHTML = '<form><input type="email" name="email"><input type="password"><button type="submit">Login</button></form>';
    const flow = driver(null, "");
    expect(flow.reports).toContainEqual(expect.objectContaining({ step: "ask", ask: "email" }));
  });
  it("asks for the missing password without submitting an incomplete combined form", () => {
    document.body.innerHTML = '<form><input type="email" name="email"><input type="password"><button type="submit">Login</button></form>';
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.querySelector("form")!.addEventListener("submit", submitted);
    const flow = driver("email", "test@example.com");
    expect(document.querySelector<HTMLInputElement>('input[type="email"]')!.value).toBe("test@example.com");
    expect(flow.reports).toContainEqual(expect.objectContaining({ step: "ask", ask: "password" }));
    expect(submitted).not.toHaveBeenCalled();
  });
  it("takes Grok's email sign-in code option after filling a combined email form", () => {
    document.body.innerHTML = '<form><input type="email"><input type="password"><button type="button">Email sign-in code</button><button type="submit">Login</button></form>';
    const codeLink = document.querySelector("button")!;
    const clicked = vi.fn(); codeLink.addEventListener("click", clicked);
    const codeSwitch = JSON.parse(grok.match(/code_switch:\s*("[^\n]*")/)![1]) as string;
    const flow = driver("email", "test@example.com", codeSwitch);
    expect(clicked).not.toHaveBeenCalled();
    flow.run(300);
    expect(clicked).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLInputElement>('input[type="email"]')!.value).toBe("test@example.com");
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  });
  it("fills a verification code and submits its form rather than a social button", () => {
    document.body.innerHTML = '<form><input autocomplete="one-time-code"><button type="submit">Continue with Google</button><button type="submit">Continue</button></form>';
    const buttons = document.querySelectorAll("button");
    const social = vi.fn((event: Event) => event.preventDefault());
    const submit = vi.fn((event: Event) => event.preventDefault());
    buttons[0].addEventListener("click", social); buttons[1].addEventListener("click", submit);
    const flow = driver("code", "123456");
    expect(document.querySelector("input")!.value).toBe("123456");
    flow.run(300);
    expect(submit).toHaveBeenCalledOnce(); expect(social).not.toHaveBeenCalled();
  });
  it("submits through the current code input if the page replaces it after typing", () => {
    document.body.innerHTML = '<form><input name="code" autocomplete="one-time-code"><button type="submit">Log in</button></form>';
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.querySelector("form")!.addEventListener("submit", submitted);
    document.querySelector("input")!.addEventListener("input", (event) => {
      const old = event.target as HTMLInputElement;
      const replacement = old.cloneNode(true) as HTMLInputElement;
      replacement.value = old.value;
      old.replaceWith(replacement);
    });
    const flow = driver("code", "123456"); flow.run(300);
    expect(submitted).toHaveBeenCalledOnce();
  });
  it("reports inline vendor code errors even when they have no alert role", () => {
    document.body.innerHTML = '<form><input name="code"><button>Log in</button></form>';
    document.querySelector("button")!.addEventListener("click", (event) => {
      event.preventDefault();
      const error = document.createElement("p"); error.textContent = "The code has expired. Request a new code."; document.querySelector("form")!.append(error);
    });
    const flow = driver("code", "123456"); flow.run(300); flow.run(800);
    expect(flow.reports).toContainEqual({ attempt: 1, step: "error", ask: "code", message: "The code has expired. Request a new code." });
  });
  it("waits when the vendor marks the code submit as aria-disabled", () => {
    document.body.innerHTML = '<form><input name="code"><button type="submit" aria-disabled="true">Log in</button></form>';
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.querySelector("form")!.addEventListener("submit", submitted);
    const flow = driver("code", "123456"); flow.run(300);
    expect(submitted).not.toHaveBeenCalled();
    document.querySelector("button")!.setAttribute("aria-disabled", "false");
    flow.run(250);
    expect(submitted).toHaveBeenCalledOnce();
  });
  it("updates OTP widgets that consume InputEvent data and commit on blur", () => {
    document.body.innerHTML = '<form><input name="code" autocomplete="one-time-code"><button type="submit">Log in</button></form>';
    let pending = ""; let code = ""; let submitted = "";
    const input = document.querySelector("input")!;
    input.addEventListener("input", (event) => { if (event instanceof InputEvent) pending = event.data ?? ""; });
    input.addEventListener("blur", () => { code = pending; });
    document.querySelector("form")!.addEventListener("submit", (event) => { event.preventDefault(); submitted = code; });
    const flow = driver("code", "123456"); flow.run(300);
    expect(submitted).toBe("123456");
  });
  it("reports a rejected verification code so the phone can retry", () => {
    document.body.innerHTML = '<form><input name="code"><button>Verify</button></form>';
    document.querySelector("button")!.addEventListener("click", (event) => {
      event.preventDefault();
      const alert = document.createElement("p"); alert.setAttribute("role", "alert"); alert.textContent = "Invalid code"; document.body.append(alert);
    });
    const flow = driver("code", "123456"); flow.run(300); flow.run(800);
    expect(flow.reports).toContainEqual({ attempt: 1, step: "error", ask: "code", message: "Invalid code" });
  });
  it("reveals a compact interactive verification that appears after code submission", () => {
    document.body.innerHTML = '<form><input name="code"><button>Verify</button></form>';
    document.querySelector("button")!.addEventListener("click", (event) => {
      event.preventDefault();
      const frame = document.createElement("iframe"); frame.src = "https://challenges.cloudflare.com/turnstile";
      frame.getBoundingClientRect = () => new DOMRect(0, 0, 300, 65); document.body.append(frame);
    });
    const flow = driver("code", "123456"); flow.run(300); flow.run(800);
    expect(flow.reports).toContainEqual({ attempt: 1, step: "challenge" });
  });
  it("waits for verification to enable the Grok sign-in button before submitting", () => {
    document.body.innerHTML = '<form><input type="password"><button type="submit" disabled>Sign in</button><button type="button">Go Back</button></form>';
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.querySelector("form")!.addEventListener("submit", submitted);
    const flow = driver("password", "test-password");
    flow.run(300);
    expect(submitted).not.toHaveBeenCalled();
    document.querySelector("button")!.disabled = false;
    flow.run(250);
    expect(submitted).toHaveBeenCalledOnce();
  });
  it("selects the mailed-code option when a password page offers it", () => {
    document.body.innerHTML = '<input type="password"><button>Email a one-time code</button>';
    const click = vi.fn(); document.querySelector("button")!.addEventListener("click", click);
    driver("password", "test-password");
    expect(click).toHaveBeenCalledOnce(); expect(document.querySelector("input")!.value).toBe("");
  });
});
