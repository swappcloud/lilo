import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DaemonShell } from "./DaemonShell";

const translations = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock("../../i18n", () => ({ useTranslation: () => translations }));
vi.mock("../../app/useApplyPreferences", () => ({ useApplyPreferences: () => {} }));
vi.mock("../../store/sessionStore", () => ({ useSessionStore: { setState: vi.fn(), getState: () => ({ providerOptions: {} }) } }));
vi.mock("../../store/mediaStore", () => ({ startMediaPolling: vi.fn(), stopMediaPolling: vi.fn() }));
vi.mock("./VoicePanel", () => ({ VoicePanel: () => <div data-testid="voice-panel"/> }));
vi.mock("../media/MediaPlayer", () => ({ MediaPlayer: () => <div data-testid="music-player"/> }));
vi.mock("../media/MusicSearch", () => ({ MusicSearch: () => <div data-testid="music-search"/> }));
vi.mock("../settings/SettingsPanel", () => ({ SettingsPanel: ({ open, sessionControl }: { open: boolean; sessionControl?: ReactNode }) => open ? <div data-testid="settings">{sessionControl}</div> : null }));

it("keeps voice, music and settings in separate app destinations", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  const host = {
    request: vi.fn(async ({ operation }: { operation: string }) => operation === "voiceStatus" ? { state: "idle", muted: false, events: [] } : { accounts: [], voiceAvailable: true, loginProviders: [], version: "test" }),
    call: vi.fn(async () => ({})),
  } as never;
  try {
    await act(async () => root.render(<DaemonShell host={host}/>));
    expect(element.querySelector('[data-testid="voice-panel"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="music-player"]')).toBeNull();
    const destination = (key: string) => [...element.querySelectorAll<HTMLButtonElement>(".daemon-app-nav button")].find(button => button.textContent === key)!;
    await act(async () => destination("music.title").click());
    expect(element.querySelector('[data-testid="voice-panel"]')).toBeNull();
    expect(element.querySelector('[data-testid="music-player"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="music-search"]')).not.toBeNull();
    await act(async () => destination("settings.title").click());
    expect(element.querySelector('[data-testid="settings"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="music-player"]')).toBeNull();
    expect(element.querySelector(".daemon-app-nav")).toBeNull();
  } finally { await act(async () => root.unmount()); }
});


it("keeps the active session stop action accessible inside settings", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  const request = vi.fn(async ({ operation }: { operation: string }) => {
    if (operation === "voiceStatus") return { state: "connected", sessionId: "fixture", muted: false, events: [] };
    if (operation === "voiceStop") return { state: "idle", muted: false, events: [] };
    return { accounts: [], voiceAvailable: true, loginProviders: [], version: "test" };
  });
  const host = { request, call: vi.fn(async () => ({})) } as never;
  const button = (key: string) => [...element.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === key)!;
  try {
    await act(async () => root.render(<DaemonShell host={host}/>));
    expect(button("daemon.voiceStop")).toBeDefined();
    await act(async () => button("settings.title").click());
    expect(element.querySelector('[data-testid="settings"] .daemon-session-control')).not.toBeNull();
    await act(async () => button("daemon.voiceStop").click());
    expect(request).toHaveBeenCalledWith({ operation: "voiceStop" });
    expect(element.querySelector('[role="status"]')?.textContent).toBe("daemon.voiceState.idle");
    expect(element.querySelector('.daemon-session-control button')).toBeNull();
    expect(request.mock.calls.filter(([input]) => input.operation === "voiceStatus")).toHaveLength(1);
  } finally { await act(async () => root.unmount()); }
});
