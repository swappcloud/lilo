import type { CommandEffect, CommandOutcome } from "../types";

/**
 * What a host must be able to do for the command router.
 *
 * The Rust router returns effects as *data*, never as UI calls, so the same
 * outcome drives this app and the headless headless Linux device daemon. This interface
 * is the desktop half of that contract — and it makes the mapping testable
 * without a live session.
 */
export interface CommandHost {
  interrupt(): void;
  endCall(): void;
  isMuted(): boolean;
  toggleMute(): void;
  sendHidden(text: string): void;
  systemTurn(text: string): void;
  toast(text: string): void;
  /** A command is waiting for the user's go-ahead. */
  confirm(command: string): void;
  clearConfirm(): void;
}

export function applyEffect(host: CommandHost, effect: CommandEffect): void {
  switch (effect.kind) {
    case "interrupt":
      host.interrupt();
      break;
    case "endCall":
      host.endCall();
      break;
    case "setMuted":
      // Mute is a toggle in the store; only act when it would actually change.
      if (host.isMuted() !== effect.muted) host.toggleMute();
      break;
    case "sendHidden":
      host.sendHidden(effect.text);
      break;
    case "systemTurn":
      host.systemTurn(effect.text);
      break;
    case "confirm":
      host.confirm(effect.command);
      break;
    case "clearConfirm":
      host.clearConfirm();
      break;
    case "toast":
      host.toast(effect.text);
      break;
    case "earcon":
      // Audible cues exist for a host without a screen; here the UI is the
      // feedback, and the music starting is the rest of it.
      break;
  }
}

export function applyOutcomes(
  host: CommandHost,
  outcomes: CommandOutcome[],
): void {
  for (const outcome of outcomes) {
    for (const effect of outcome.effects) {
      applyEffect(host, effect);
    }
  }
}
