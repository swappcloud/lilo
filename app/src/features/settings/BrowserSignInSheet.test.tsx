import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserFrame, BrowserPort } from "../../lib/browserPort";
import { BrowserSignInSheet } from "./BrowserSignInSheet";

const mocks = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("../../providers", () => ({ providerMeta: () => ({ shortLabel: "Fixture provider" }) }));
vi.mock("../../lib/gateway", () => ({ listAccounts: async () => [] }));
vi.mock("../../store/sessionStore", () => ({ useSessionStore: { setState: vi.fn() } }));

let root: Root;
let element: HTMLDivElement;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { value: vi.fn(), configurable: true });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { value: vi.fn(), configurable: true });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  document.body.innerHTML = "";
});

async function show(frame: BrowserFrame) {
  const browser: BrowserPort = { supports: () => true, exchange: vi.fn(async () => frame) };
  await act(async () => root.render(<BrowserSignInSheet browser={browser} provider="fixture" onClose={() => {}}/>));
  return browser;
}

it("uses visible email and code fields, hides only passwords, and omits normal-page mirroring", async () => {
  for (const [ask, type] of [["email", "email"], ["code", "text"], ["password", "password"]] as const) {
    const browser = await show({ phase: "login", step: "ask", ask, image: "fixture-image" });
    expect(element.querySelector<HTMLInputElement>("input")?.type).toBe(type);
    expect(element.querySelectorAll("input")).toHaveLength(1);
    expect(element.querySelector("img")).toBeNull();
    expect(element.textContent).not.toContain("daemon.typeFocused");
    expect(element.textContent).not.toContain("daemon.showPage");
    await act(async () => root.render(<BrowserSignInSheet browser={browser} provider="fixture" onClose={() => {}}/>));
  }
});

it("keeps the form out of the working state and displays provider answer errors", async () => {
  await show({ phase: "login", step: "working" });
  expect(element.textContent).toContain("daemon.working");
  expect(element.querySelector("input")).toBeNull();
  await show({ phase: "login", step: "error", ask: "password", message: "Incorrect password" });
  expect(element.querySelector('[role="alert"]')?.textContent).toBe("Incorrect password");
  expect(element.querySelector<HTMLInputElement>("input")?.type).toBe("password");
});
