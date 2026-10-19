import { isPlaying, useMediaStore } from "../../store/mediaStore";
import { useTranslation } from "../../i18n";
import { toast } from "../../store/toastStore";
import {
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  StopIcon,
} from "../../shared/ui/icons";

/**
 * The now-playing bar.
 *
 * Only rendered while a track is loaded, so it never competes with the voice
 * controls for attention. The music itself is visualized on the orb — this
 * stays a plain, compact transport.
 */
export function MediaPlayer() {
  const { t } = useTranslation();
  const nowPlaying = useMediaStore((s) => s.nowPlaying);
  const playerFound = useMediaStore((s) => s.playerFound);
  const busy = useMediaStore((s) => s.busy);
  const run = useMediaStore((s) => s.run);

  if (!playerFound || !isPlaying(nowPlaying)) return null;

  const paused = nowPlaying?.paused ?? false;
  const title = nowPlaying?.title || t("player.unknownTrack");
  const artist = nowPlaying?.artist ?? "";

  const transport = [
    {
      key: "previous",
      command: "media_previous",
      label: t("player.previous"),
      busyLabel: t("player.goingBack"),
      icon: <PreviousIcon size={16} />,
      className: "player-btn",
    },
    {
      key: "toggle",
      command: paused ? "media_resume" : "media_pause",
      label: paused ? t("player.play") : t("player.pause"),
      busyLabel: paused ? t("player.resuming") : t("player.pausing"),
      icon: paused ? <PlayIcon size={18} /> : <PauseIcon size={18} />,
      className: "player-btn player-btn--primary",
    },
    {
      key: "next",
      command: "media_next",
      label: t("player.next"),
      busyLabel: t("player.skipping"),
      icon: <NextIcon size={16} />,
      className: "player-btn",
    },
    {
      key: "stop",
      command: "media_stop",
      label: t("player.stop"),
      busyLabel: t("player.stopping"),
      icon: <StopIcon size={14} />,
      className: "player-btn player-btn--stop",
    },
  ];

  return (
    <div className={`player${paused ? " is-paused" : ""}`} role="group">
      {nowPlaying?.artworkUrl && <img className="player-artwork" src={nowPlaying.artworkUrl} alt="" referrerPolicy="no-referrer"/>}
      <span className="player-info">
        <span className="player-state">
          {paused ? t("player.paused") : t("player.nowPlaying")}
          {artist && ` · ${artist}`}
        </span>
        <span className="player-title">{title}</span>
      </span>

      <span className="player-controls">
        {transport.map((control) => {
          const running = busy === control.command;
          return (
            <button
              key={control.key}
              type="button"
              className={`${control.className}${running ? " is-busy" : ""}`}
              onClick={() => void run(control.command).catch(() => toast(t("music.playError")))}
              disabled={busy !== null}
              aria-label={control.label}
              title={running ? control.busyLabel : control.label}
            >
              {control.icon}
            </button>
          );
        })}
      </span>
    </div>
  );
}
