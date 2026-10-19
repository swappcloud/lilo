import { describe, expect, it, vi } from "vitest";

import { applyEffect, applyOutcomes, type CommandHost } from "./commandEffects";
import type { CommandOutcome } from "../types";

function host(overrides: Partial<CommandHost> = {}) {
  return {
    interrupt: vi.fn(),
    endCall: vi.fn(),
    isMuted: vi.fn(() => false),
    toggleMute: vi.fn(),
    sendHidden: vi.fn(),
    systemTurn: vi.fn(),
    toast: vi.fn(),
    confirm: vi.fn(),
    clearConfirm: vi.fn(),
    ...overrides,
  } satisfies CommandHost;
}

describe("command effects", () => {
  it("dismisses the prompt after a voice answer", () => {
    const h = host();
    applyOutcomes(h, [{
      command: "desktop.type", scope: "tool", tool: null, args: {},
      consume: true, effects: [{ kind: "clearConfirm" }],
    }]);
    expect(h.clearConfirm).toHaveBeenCalledOnce();
    expect(h.confirm).not.toHaveBeenCalled();
  });
  it("routes a confirmation to the host instead of running anything", () => {
    const h = host();
    applyOutcomes(h, [
      {
        command: "notes.clear",
        scope: "tool",
        tool: null,
        args: {},
        consume: true,
        effects: [{ kind: "confirm", command: "notes.clear" }],
      },
    ]);
    expect(h.confirm).toHaveBeenCalledWith("notes.clear");
  });

  it("cuts the assistant off and hangs up for an end-call outcome", () => {
    const h = host();
    // The user's audio already reached the provider, so barge-in is what stops
    // the model from answering a command it cannot run.
    applyOutcomes(h, [
      {
        command: "end-call",
        scope: "session",
        tool: null,
        args: {},
        consume: true,
        effects: [
          { kind: "interrupt" },
          { kind: "endCall" },
          { kind: "toast", text: "Conversation ended" },
          { kind: "earcon", cue: "ack" },
        ],
      },
    ]);
    expect(h.interrupt).toHaveBeenCalledOnce();
    expect(h.endCall).toHaveBeenCalledOnce();
    expect(h.toast).toHaveBeenCalledWith("Conversation ended");
  });

  it("only toggles mute when the state would actually change", () => {
    const muted = host({ isMuted: vi.fn(() => true) });
    applyEffect(muted, { kind: "setMuted", muted: true });
    expect(muted.toggleMute).not.toHaveBeenCalled();

    applyEffect(muted, { kind: "setMuted", muted: false });
    expect(muted.toggleMute).toHaveBeenCalledOnce();
  });

  it("sends the model a hidden note rather than a visible turn", () => {
    const h = host();
    applyEffect(h, { kind: "sendHidden", text: "[LILO] playing: Queen" });
    expect(h.sendHidden).toHaveBeenCalledWith("[LILO] playing: Queen");
    expect(h.systemTurn).not.toHaveBeenCalled();
  });

  it("writes a system turn for transcript feedback", () => {
    const h = host();
    applyEffect(h, { kind: "systemTurn", text: "playing: Queen" });
    expect(h.systemTurn).toHaveBeenCalledWith("playing: Queen");
  });

  it("ignores earcons on a host that has a screen", () => {
    const h = host();
    applyEffect(h, { kind: "earcon", cue: "ack" });
    expect(Object.values(h).every((fn) => !("mock" in fn) || fn.mock.calls.length === 0)).toBe(
      true,
    );
  });

  it("applies every effect of every outcome in order", () => {
    const order: string[] = [];
    const h = host({
      interrupt: vi.fn(() => void order.push("interrupt")),
      systemTurn: vi.fn(() => void order.push("systemTurn")),
      sendHidden: vi.fn(() => void order.push("sendHidden")),
    });
    const outcomes: CommandOutcome[] = [
      {
        command: "media.play",
        scope: "tool",
        tool: "media_play",
        args: { track: "creep" },
        consume: true,
        effects: [
          { kind: "interrupt" },
          { kind: "systemTurn", text: "a" },
          { kind: "sendHidden", text: "b" },
        ],
      },
    ];
    applyOutcomes(h, outcomes);
    expect(order).toEqual(["interrupt", "systemTurn", "sendHidden"]);
  });

  it("does nothing for an empty outcome list", () => {
    const h = host();
    applyOutcomes(h, []);
    expect(h.interrupt).not.toHaveBeenCalled();
  });
});
