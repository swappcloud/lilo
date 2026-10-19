import { useSessionStore } from "../../store/sessionStore";
import { useTranslation } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import type { ConnectionState } from "../../types";

const LABELS: Record<ConnectionState, TranslationKey> = {
  idle: "status.ready",
  connecting: "status.connecting",
  connected: "status.live",
  reconnecting: "status.reconnecting",
  disconnected: "status.ready",
  error: "status.error",
};

/**
 * Session state as a quiet dot in the corner.
 *
 * It used to sit in the topbar next to the title, where it competed with the
 * brand for attention. Now it only speaks when asked: the label appears on
 * hover or keyboard focus.
 */
export function StatusDot() {
  const { t } = useTranslation();
  const connectionState = useSessionStore((s) => s.connectionState);
  const muted = useSessionStore((s) => s.muted);

  const isMuted = connectionState === "connected" && muted;
  const label = isMuted ? t("status.muted") : t(LABELS[connectionState]);

  return (
    <div className="status-dot" data-state={isMuted ? "muted" : connectionState}>
      <button type="button" className="status-dot-btn" aria-label={label}>
        <i />
      </button>
      <span className="status-dot-label" role="status">
        {label}
      </span>
    </div>
  );
}
