import { useEffect, useState } from "react";

import { formatDuration } from "../../shared/lib/format";
import { useSessionStore } from "../../store/sessionStore";
import type { VoicePhase } from "./orbRenderer";

/** Derive the orb phase from the live session state. */
export function useVoicePhase(): VoicePhase {
  const connectionState = useSessionStore((s) => s.connectionState);
  const assistantSpeaking = useSessionStore((s) => s.assistantSpeaking);

  switch (connectionState) {
    case "connected":
      return assistantSpeaking ? "speaking" : "listening";
    case "connecting":
    case "reconnecting":
      return "thinking";
    default:
      return "idle";
  }
}

/** Seconds since the session became live, reset when it stops. */
export function useSessionTimer(): { active: boolean; label: string } {
  const connectionState = useSessionStore((s) => s.connectionState);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (connectionState === "connected") {
      setStartedAt((prev) => prev ?? Date.now());
    } else {
      setStartedAt(null);
    }
  }, [connectionState]);

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (startedAt === null) return { active: false, label: "0:00" };

  return { active: true, label: formatDuration((now - startedAt) / 1000) };
}
