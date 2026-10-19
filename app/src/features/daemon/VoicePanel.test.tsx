import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountView } from "../../types";
import type { DaemonVoiceStatus } from "./daemonHost";
import { VoicePanel, mergeVoiceEvents } from "./VoicePanel";
import { useDaemonVoice } from "./useDaemonVoice";
import type { DaemonHost } from "./daemonHost";
function TestPanel({ host, available = true }: { host: DaemonHost; available?: boolean }) {
  const voice = useDaemonVoice(host);
  return <VoicePanel voice={voice} accounts={[account]} available={available}/>;
}

const mocks = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: mocks.t }) }));

const account: AccountView = {
  provider: "chatgpt-web", email: "fixture@example.invalid", name: "Fixture", org: "", deviceId: "fixture",
  status: "ok", proxy: "", hasToken: true, expiresAt: null, plan: null,
};

let root: Root;
let element: HTMLDivElement;
let status: DaemonVoiceStatus;
let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  status = { state: "idle", muted: false, events: [] };
  request = vi.fn(async (operation: Record<string, unknown>) => {
    switch (operation.operation) {
      case "voiceStart":
        status = { state: "connected", muted: false, sessionId: "session-fixture", providerId: "chatgpt-web", accountEmail: account.email,
          events: [{ sequence: 1, speaker: "assistant", text: "Ready", final: true }] };
        return status;
      case "voiceMute":
        status = { ...status, muted: operation.muted as boolean };
        return status;
      case "voiceStop":
        status = { state: "idle", muted: false, events: [] };
        return status;
      case "voiceStatus": return status;
      default: return status;
    }
  });
  element = document.createElement("div");
  root = createRoot(element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(available = true) {
  const host = { request } as never;
  await act(async () => root.render(<TestPanel host={host} available={available}/>));
  await act(async () => { await Promise.resolve(); });
  return host;
}

function button(label: string): HTMLButtonElement {
  return Array.from(element.querySelectorAll("button")).find(item => item.textContent?.trim() === label)!;
}

it("uses public account identity, gates start on voice availability, and does not start automatically", async () => {
  await mount(false);
  expect(element.querySelector("select")?.textContent).toContain("fixture@example.invalid");
  expect(button("daemon.voiceStart").disabled).toBe(true);
  expect(request.mock.calls.map(([operation]) => operation.operation)).toEqual(["voiceStatus"]);

  await act(async () => root.render(<TestPanel host={{ request } as never}/>));
  await act(async () => button("daemon.voiceStart").click());
  expect(request).toHaveBeenCalledWith({
    operation: "voiceStart",
    providerId: account.provider,
    email: account.email,
    resolvedLanguage: navigator.language,
  });
  expect(element.textContent).toContain("daemon.voiceState.connected");
  expect(element.textContent).toContain("Ready");
});

it("sends mute, interrupt, text, and stop controls without stopping on unmount", async () => {
  await mount();
  await act(async () => button("daemon.voiceStart").click());
  await act(async () => button("daemon.voiceMute").click());
  expect(request).toHaveBeenCalledWith({ operation: "voiceMute", muted: true });
  await act(async () => button("daemon.voiceInterrupt").click());

  const input = element.querySelector<HTMLInputElement>("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, "hello from the phone");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => element.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(request).toHaveBeenCalledWith({ operation: "voiceText", text: "hello from the phone" });
  await act(async () => button("daemon.voiceStop").click());
  expect(request).toHaveBeenCalledWith({ operation: "voiceStop" });

  const operationsBeforeUnmount = request.mock.calls.map(([operation]) => operation.operation);
  await act(async () => root.unmount());
  expect(request.mock.calls.map(([operation]) => operation.operation)).toEqual(operationsBeforeUnmount);
  root = createRoot(element);
});

it("deduplicates and bounds captions by their sequence number", () => {
  const merged = mergeVoiceEvents(
    [{ sequence: 2, speaker: "assistant", text: "old", final: false, turnId: "assistant-turn" }],
    [
      { sequence: 2, speaker: "assistant", text: "revised", final: false, turnId: "assistant-turn" },
      { sequence: 3, speaker: "assistant", text: "final revision", final: true, turnId: "assistant-turn" },
      { sequence: 1, speaker: "user", text: "hello", final: true, turnId: "user-turn" },
    ],
  );
  expect(merged.map(event => [event.sequence, event.text])).toEqual([[1, "hello"], [3, "final revision"]]);
  const bounded = mergeVoiceEvents([], Array.from({ length: 60 }, (_, index) => ({ sequence: index, speaker: "user" as const, text: `${index}`, final: true })));
  expect(bounded).toHaveLength(50);
  expect(bounded[0].sequence).toBe(10);
});
