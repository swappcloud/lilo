import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useTranslation } from "../../i18n";
import { log } from "../../lib/log";
import { useMediaStore } from "../../store/mediaStore";
import { RangeSlider } from "../../shared/ui/controls";
import {
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  QueueIcon,
  StopIcon,
  VolumeIcon,
} from "../../shared/ui/icons";
import { Button } from "../../shared/ui/primitives";

export type MediaPopover = "volume" | "queue";

function run(tool: string, args?: Record<string, unknown>): void {
  void useMediaStore
    .getState()
    .run(tool, args)
    .catch((error: unknown) => log("companion", `${tool} failed: ${String(error)}`));
}

interface RingProps {
  leaving: boolean;
  popover: MediaPopover | null;
  onPopover: (next: MediaPopover | null) => void;
}

/**
 * Five small controls along LILO's lower edge, only while music is loaded:
 * previous, volume, play/pause (the larger one), next and the queue.
 */
export function MediaRing({ leaving, popover, onPopover }: RingProps) {
  const { t } = useTranslation();
  const nowPlaying = useMediaStore((s) => s.nowPlaying);
  const busy = useMediaStore((s) => s.busy);
  const paused = nowPlaying?.paused ?? false;

  const toggle = (which: MediaPopover) => onPopover(popover === which ? null : which);

  const buttons: Array<{ key: string; label: string; icon: ReactNode; onClick: () => void; on?: boolean }> = [
    {
      key: "previous",
      label: t("player.previous"),
      icon: <PreviousIcon size={13} />,
      onClick: () => run("media_previous"),
    },
    {
      key: "volume",
      label: t("companion.volume"),
      icon: <VolumeIcon size={14} />,
      onClick: () => toggle("volume"),
      on: popover === "volume",
    },
    {
      key: "toggle",
      label: paused ? t("player.play") : t("player.pause"),
      icon: paused ? <PlayIcon size={17} /> : <PauseIcon size={17} />,
      onClick: () => run(paused ? "media_resume" : "media_pause"),
    },
    {
      key: "next",
      label: t("player.next"),
      icon: <NextIcon size={13} />,
      onClick: () => run("media_next"),
    },
    {
      key: "queue",
      label: t("companion.queue"),
      icon: <QueueIcon size={14} />,
      onClick: () => toggle("queue"),
      on: popover === "queue",
    },
  ];

  return (
    <div
      className="companion-ring"
      role="group"
      aria-label={t("companion.controls")}
      data-leaving={leaving ? "true" : undefined}
    >
      {buttons.map((button, index) => (
        <button
          key={button.key}
          type="button"
          data-hit
          className={`ring-btn ring-btn--${button.key}${button.on ? " on" : ""}`}
          style={{ "--i": index } as CSSProperties}
          title={button.label}
          aria-label={button.label}
          aria-busy={busy !== null && button.key === "toggle"}
          onClick={button.onClick}
        >
          {button.icon}
        </button>
      ))}
    </div>
  );
}

/** Volume, applied as the slider settles rather than on every step. */
export function VolumePopover() {
  const { t } = useTranslation();
  const volume = useMediaStore((s) => s.nowPlaying?.volume ?? 100);
  const [value, setValue] = useState(volume);
  const timer = useRef<number | undefined>(undefined);
  const dragging = useRef(false);

  // Follow the player unless the user is moving the slider.
  useEffect(() => {
    if (!dragging.current) setValue(volume);
  }, [volume]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const change = (next: number) => {
    dragging.current = true;
    setValue(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      dragging.current = false;
      run("media_volume", { level: String(Math.round(next)) });
    }, 220);
  };

  return (
    <div className="bubble-volume">
      <RangeSlider label={`${t("companion.volume")} · ${Math.round(value)}%`} value={value} onChange={change} />
    </div>
  );
}

/** What is playing, how much follows it, and a way to stop it all. */
export function QueuePopover() {
  const { t } = useTranslation();
  const nowPlaying = useMediaStore((s) => s.nowPlaying);
  if (!nowPlaying) return null;
  const upcoming = Math.max(0, nowPlaying.queueLength - 1);
  return (
    <div className="bubble-queue">
      <span className="bubble-kicker">
        {nowPlaying.paused ? t("player.paused") : t("player.nowPlaying")}
      </span>
      <strong className="bubble-title">{nowPlaying.title || t("player.unknownTrack")}</strong>
      {nowPlaying.artist && <span className="bubble-sub">{nowPlaying.artist}</span>}
      <div className="bubble-row">
        <span className="bubble-sub">{t("companion.queueCount", { count: upcoming })}</span>
        <Button small onClick={() => run("media_stop")}>
          <StopIcon size={12} /> {t("player.stop")}
        </Button>
      </div>
    </div>
  );
}
