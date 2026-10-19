import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import type { DaemonHost, DaemonVoiceEvent, DaemonVoiceStatus } from "./daemonHost";

const MAX_CAPTIONS = 50;
const EMPTY_STATUS: DaemonVoiceStatus = { state: "idle", muted: false, events: [] };

export function mergeVoiceEvents(previous: DaemonVoiceEvent[], incoming: DaemonVoiceEvent[]): DaemonVoiceEvent[] {
  const keyOf = (event: DaemonVoiceEvent) => event.turnId ? `${event.speaker}\u0000${event.turnId}` : `sequence\u0000${event.sequence}`;
  const events = new Map(previous.map(event => [keyOf(event), event]));
  for (const event of incoming) events.set(keyOf(event), event);
  return [...events.values()].sort((left, right) => left.sequence - right.sequence).slice(-MAX_CAPTIONS);
}


/** One session controller shared by phone voice and global controls. */
export function useDaemonVoice(host: DaemonHost | null) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DaemonVoiceStatus>(EMPTY_STATUS);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const clearEventsRef = useRef(false);
  const operationVersion = useRef(0);

  const accept = useCallback((next: DaemonVoiceStatus) => {
    setLoaded(true);
    const previousEvents = clearEventsRef.current ? [] : undefined;
    clearEventsRef.current = false;
    setStatus(previous => ({ ...next, events: mergeVoiceEvents(previousEvents ?? previous.events, next.events ?? []) }));
    setError(next.state === "error" ? next.error ?? t("daemon.voiceActionError") : null);
  }, [t]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    const poll = async () => {
      if (!host || !active || document.hidden || polling || busyRef.current) return schedule();
      polling = true;
      const version = operationVersion.current;
      try {
        const next = await host.request<DaemonVoiceStatus>({ operation: "voiceStatus" });
        if (active && version === operationVersion.current) accept(next);
      } catch {
        if (active) setError(t("daemon.voiceActionError"));
      } finally {
        polling = false;
        schedule();
      }
    };
    const schedule = () => {
      if (active && !document.hidden) timer = setTimeout(() => void poll(), 1000);
    };
    const visibilityChanged = () => {
      if (timer) clearTimeout(timer);
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [accept, host, t]);

  const run = async (operation: string, fields: Record<string, unknown> = {}) => {
    if (!host || busyRef.current) return;
    operationVersion.current++;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await host.request<DaemonVoiceStatus>({ operation, ...fields });
      accept(next);
    } catch {
      setError(t("daemon.voiceActionError"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };


  const reset = () => { clearEventsRef.current = true; setStatus(EMPTY_STATUS); };
  const active = status.state === "starting" || status.state === "connected" || !!status.sessionId;
  return { status, busy, error, active, loaded, run, reset };
}
export type DaemonVoiceController = ReturnType<typeof useDaemonVoice>;
