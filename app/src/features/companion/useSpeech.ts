import { useEffect, useState } from "react";

import { selectActiveConversation, useSessionStore } from "../../store/sessionStore";
import { holdMs } from "./geometry";

/**
 * What LILO is saying right now, for the speech bubble: the latest reply while
 * it is spoken, kept for a readable moment after, then nothing. A new turn
 * from the user clears it once playback has stopped.
 */
export function useSpeech(): string | null {
  const turns = useSessionStore((s) => selectActiveConversation(s)?.turns);
  const activeId = useSessionStore((s) => s.activeId);
  const connected = useSessionStore((s) => s.connectionState === "connected");
  const speaking = useSessionStore(
    (s) => (s.assistantSpeaking || s.outputLevel > 0.02) && s.connectionState === "connected",
  );
  const last = turns?.[turns.length - 1];
  const [liveReply, setLiveReply] = useState<{ conversationId: string; id: string } | null>(null);
  useEffect(() => {
    if (!connected || !speaking || !activeId) {
      setLiveReply(null);
    } else if (last?.speaker === "assistant") {
      setLiveReply((previous) => previous?.conversationId === activeId && previous.id === last.id
        ? previous : { conversationId: activeId, id: last.id });
    }
  }, [connected, speaking, activeId, last?.id, last?.speaker]);
  const assistant = last?.speaker === "assistant" ? last
    : speaking && liveReply?.conversationId === activeId
      ? turns?.find((turn) => turn.id === liveReply.id && turn.speaker === "assistant") : undefined;
  const reply = assistant?.text.trim() ?? "";
  const replyId = assistant?.id ?? null;
  const [expired, setExpired] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    if (!connected || !replyId || !reply) {
      setExpired(null);
      return;
    }
    if (speaking) {
      setExpired(null);
      return;
    }
    // Finished speaking: hold, then let the bubble go.
    const timer = window.setTimeout(() => setExpired({ id: replyId, text: reply }), holdMs(reply));
    return () => window.clearTimeout(timer);
    // The text grows while speaking; only its end restarts the hold.
  }, [connected, replyId, reply, speaking]);

  if (!connected || !reply || !replyId) return null;
  return speaking || expired?.id !== replyId || expired.text !== reply ? reply : null;
}
