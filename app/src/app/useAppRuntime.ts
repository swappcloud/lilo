import { useEffect } from "react";

import { startDeviceLocation } from "../features/location/deviceLocation";
import { useWakeWord } from "../features/voice/useWakeWord";
import { startMusicLevels, stopMusicLevels } from "../lib/musicLevels";
import { usePermissionWatch } from "../shared/hooks/usePermissionWatch";
import { isPlaying, startMediaPolling, stopMediaPolling, useMediaStore } from "../store/mediaStore";
import { usePreferencesStore } from "../store/preferencesStore";

/**
 * Everything that keeps LILO running, whichever shell is on screen: the wake
 * word, the permission watch, the media poller, the device location and the
 * music levels. Both shells call it, so switching between them never drops
 * one of these.
 */
export function useAppRuntime(): void {
  useWakeWord();
  usePermissionWatch();

  // One poller for the whole app: the player and the microphone gate both
  // read `mediaStore`.
  useEffect(() => {
    startMediaPolling();
    return stopMediaPolling;
  }, []);

  const playing = isPlaying(useMediaStore((s) => s.nowPlaying));
  const animations = usePreferencesStore((s) => s.animations);
  useEffect(() => {
    document.documentElement.dataset.player = playing ? "on" : "off";
  }, [playing]);

  useEffect(() => startDeviceLocation(), []);

  // Only animated visualizers consume live music levels. Playback and voice
  // keep running independently when animations are off or the window is hidden.
  useEffect(() => {
    if (!playing || !animations) return;
    startMusicLevels();
    return stopMusicLevels;
  }, [playing, animations]);
}
