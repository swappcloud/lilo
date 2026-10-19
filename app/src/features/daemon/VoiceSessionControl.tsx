import { useTranslation } from "../../i18n";
import { Button } from "../../shared/ui/primitives";
import type { DaemonVoiceController } from "./useDaemonVoice";

/** Session status and a stop action available from every phone destination. */
export function VoiceSessionControl({ voice }: { voice: DaemonVoiceController }) {
  const { t } = useTranslation();
  return <div className="daemon-session-control">
    <p role="status">{voice.error ?? t(voice.loaded ? `daemon.voiceState.${voice.status.state}` : "daemon.voiceChecking")}</p>
    {voice.active && <Button variant="primary" disabled={voice.busy} onClick={() => void voice.run("voiceStop")}>
      {t("daemon.voiceStop")}
    </Button>}
  </div>;
}
