import { ProviderLimitNotice } from "./ProviderLimitNotice";
import { useSessionStore } from "../../store/sessionStore";
import { useTranslation } from "../../i18n";
import { MediaPlayer } from "../media/MediaPlayer";
import { MicIcon, MicOffIcon, StopIcon, TranscriptIcon } from "../../shared/ui/icons";

interface Props {
  transcriptOpen: boolean;
  onToggleTranscript: () => void;
}

export function ControlDock({ transcriptOpen, onToggleTranscript }: Props) {
  const { t } = useTranslation();
  const connectionState = useSessionStore((s) => s.connectionState);
  const muted = useSessionStore((s) => s.muted);
  const toggleMute = useSessionStore((s) => s.toggleMute);
  const connect = useSessionStore((s) => s.connect);
  const disconnect = useSessionStore((s) => s.disconnect);

  const live = connectionState === "connected";
  const busy =
    connectionState === "connecting" || connectionState === "reconnecting";
  const active = live || busy;
  // Only while a conversation is live — or while its panel is already open, so
  // it can always be closed.
  const showTranscript = live || transcriptOpen;

  return (
    <footer className="dock glass">
      {/* The player shares the dock with the voice controls: it appears only
          while a track is loaded, on its own row above them. */}
      <MediaPlayer />
      <ProviderLimitNotice />

      <div className="dock-buttons">
        {live && (
          <button
            className={`round${muted ? " is-active" : ""}`}
            onClick={toggleMute}
            aria-label={muted ? t("dock.unmute") : t("dock.mute")}
            title={muted ? t("dock.unmuteShort") : t("dock.muteShort")}
          >
            {muted ? <MicOffIcon /> : <MicIcon />}
          </button>
        )}

        <button
          className={`micbtn${active ? " is-end" : ""}`}
          onClick={() => (active ? void disconnect() : void connect())}
          aria-label={active ? t("dock.end") : t("dock.start")}
          title={active ? t("dock.end") : t("dock.startShort")}
        >
          {active ? <StopIcon size={22} /> : <MicIcon size={26} />}
        </button>

        {showTranscript && (
          <button
            className={`round${transcriptOpen ? " is-active" : ""}`}
            onClick={onToggleTranscript}
            aria-label={t("dock.toggleTranscript")}
            title={t("dock.transcriptTitle")}
          >
            <TranscriptIcon size={19} />
          </button>
        )}
      </div>
    </footer>
  );
}