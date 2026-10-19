import { useEffect, useRef } from "react";

import { selectActiveConversation, useSessionStore } from "../../store/sessionStore";
import { useTranslation } from "../../i18n";
import { SlidePanel } from "../../shared/ui/primitives";
import { MessageBubble } from "./MessageBubble";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function TranscriptPanel({ open, onClose }: Props) {
  const { t } = useTranslation();
  const conversation = useSessionStore(selectActiveConversation);
  const connectionState = useSessionStore((s) => s.connectionState);
  const sendText = useSessionStore((s) => s.sendText);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);

  const turns = conversation?.turns ?? [];
  const live = connectionState === "connected";
  const lastText = turns[turns.length - 1]?.text;

  const suggestions = [
    t("transcript.suggestion1"),
    t("transcript.suggestion2"),
    t("transcript.suggestion3"),
  ];

  useEffect(() => {
    following.current = true;
  }, [open, conversation?.id]);

  useEffect(() => {
    if (!open || !following.current) return;
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
  }, [open, conversation?.id, turns.length, lastText]);

  return (
    <SlidePanel
      title={t("transcript.title")}
      open={open}
      onClose={onClose}
      headerExtra={
        <span className="live">
          <i />
          {t("transcript.live")}
        </span>
      }
    >
      <div className="msgs" ref={scrollRef} onScroll={() => {
        const container = scrollRef.current;
        if (container) following.current = container.scrollHeight - container.clientHeight - container.scrollTop < 48;
      }}>
        {turns.length === 0 ? (
          <div className="empty">
            <p className="muted">{t("transcript.empty")}</p>
            <div className="suggestions">
              {suggestions.map((text) => (
                <button
                  key={text}
                  className="chipbtn"
                  disabled={!live}
                  onClick={() => sendText(text)}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn) => <MessageBubble key={turn.id} turn={turn} />)
        )}
        <div ref={bottomRef} />
      </div>
    </SlidePanel>
  );
}
