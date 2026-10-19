import { useState } from "react";
import { copyText } from "../../lib/copyText";
import { useTranslation } from "../../i18n";
import { CopyIcon, CheckIcon } from "../../shared/ui/icons";
import { formatTime } from "../../shared/lib/format";
import type { TranscriptTurn } from "../../types";

const ROLE_CLASS: Record<TranscriptTurn["speaker"], string> = {
  user: "user",
  assistant: "ai",
  system: "sys",
};

export function MessageBubble({ turn }: { turn: TranscriptTurn }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try { await copyText(turn.text); setStatus("copied"); }
    catch { setStatus("failed"); }
  };
  return (
    <div className={`msg ${ROLE_CLASS[turn.speaker]}${turn.final ? "" : " partial"}`}>
      {turn.text}
      {!turn.final && (
        <span className="eq" aria-hidden>
          <i />
          <i />
          <i />
        </span>
      )}
      <div className="msg-footer">
        <span className="t">{formatTime(turn.timestamp)}</span>
        <button className="msg-copy" aria-label={t("transcript.copy")} title={t(status === "copied" ? "transcript.copied" : "transcript.copy")} onClick={() => void copy()}>
          {status === "copied" ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        </button>
      </div>
      {status !== "idle" && <span className={status === "failed" ? "t" : "msg-copy-status"} role="status">{t(status === "copied" ? "transcript.copied" : "transcript.copyFailed")}</span>}
    </div>
  );
}
