import { translate } from "../i18n";
import { log } from "../lib/log";
import { usePreferencesStore } from "./preferencesStore";
import { selectActiveConversation, useSessionStore } from "./sessionStore";
import { toast } from "./toastStore";

/** A deadline based on wall time also survives throttled background timers. */
export class IdleDeadline {
  private since: number | undefined;
  private seconds = 0;
  private active = false;
  private expired = false;

  activity(now: number): void {
    this.since = now;
  }

  check(now: number, active: boolean, speaking: boolean, seconds: number): boolean {
    if (!active || !this.active || seconds === 0 || seconds !== this.seconds) {
      this.since = now;
      this.expired = false;
      this.seconds = seconds;
      this.active = active;
      return false;
    }
    if (speaking || this.since === undefined) this.since = now;
    if (this.expired || now - this.since < seconds * 1000) return false;
    this.expired = true;
    return true;
  }
}

/** Runs in the owner window, including when a session was started by voice. */
export function startSessionIdleWatch(): () => void {
  const deadline = new IdleDeadline();
  const activity = () => deadline.activity(Date.now());
  const tick = () => {
    const state = useSessionStore.getState();
    const active = state.connectionState === "connected" || state.connectionState === "reconnecting";
    const speaking = state.assistantSpeaking || state.outputLevel > 0.02 || (!state.muted && state.micLevel > 0.06);
    if (deadline.check(Date.now(), active, speaking, usePreferencesStore.getState().idleTimeoutSeconds)) {
      log("session", "stopped after inactivity");
      void state.disconnect().then(() => toast(translate("conversation.idleClosed"))).catch(() => {
        log("session", "failed to stop after inactivity");
      });
    }
  };
  const unsubscribe = useSessionStore.subscribe((state, previous) => {
    if (state.activeId !== previous.activeId || state.connectionState !== previous.connectionState ||
      selectActiveConversation(state)?.turns !== selectActiveConversation(previous)?.turns) activity();
    tick();
  });
  const unsubscribePreferences = usePreferencesStore.subscribe((state, previous) => {
    if (state.idleTimeoutSeconds !== previous.idleTimeoutSeconds) tick();
  });
  window.addEventListener("pointerdown", activity);
  window.addEventListener("keydown", activity);
  const timer = window.setInterval(tick, 250);
  tick();
  return () => {
    window.clearInterval(timer);
    unsubscribe();
    unsubscribePreferences();
    window.removeEventListener("pointerdown", activity);
    window.removeEventListener("keydown", activity);
  };
}
