import { useCallback, useEffect, useState } from "react";
import { useSessionStore } from "../../store/sessionStore";
import { Toast } from "../../shared/ui/Toast";
import { SettingsPanel } from "../settings/SettingsPanel";
import { applyRustOptionMirrors } from "../../providers/contract";
import { Button } from "../../shared/ui/primitives";
import { MicIcon, WaveIcon, SettingsIcon } from "../../shared/ui/icons";
import { useTranslation } from "../../i18n";
import type { AppSettings } from "../../types";
import type { DaemonHost, DaemonState } from "./daemonHost";
import { useApplyPreferences } from "../../app/useApplyPreferences";
import { usePreferencesStore } from "../../store/preferencesStore";
import { DeviceSection } from "./DeviceSection";
import { VoicePanel } from "./VoicePanel";
import { useDaemonVoice } from "./useDaemonVoice";
import { VoiceSessionControl } from "./VoiceSessionControl";
import type { SettingsPage } from "../settings/sections";
import { MediaPlayer } from "../media/MediaPlayer";
import { MusicSearch } from "../media/MusicSearch";
import { startMediaPolling, stopMediaPolling } from "../../store/mediaStore";

const DAEMON_PAGE_IDS = ["account", "appearance", "language", "provider", "media", "plugins"] as const;
const DEVICE_PAGES: readonly SettingsPage[] = [{ id: "daemon-device", group: "general", labelKey: "daemon.devicePreferences", Component: DeviceSection }];

/** Reuses the desktop settings panel and its account, provider, and plugin pages. */
export function DaemonShell({ host }: { host: DaemonHost | null }) {
  useApplyPreferences();
  const voice = useDaemonVoice(host);
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [page, setPage] = useState<"voice" | "music">("voice");
  const [state, setState] = useState<DaemonState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!host) return;
    try {
      const [state, settings] = await Promise.all([
        host.request<DaemonState>({ operation: "state" }),
        host.call<AppSettings>("get_settings"),
      ]);
      if (host.browser) host.browser.providers = state.loginProviders ?? [];
      if (state.device) usePreferencesStore.setState({ language: state.device.language, wakePhrase: state.device.wakePhrase, wakeWord: state.device.wakeWord ?? true, animations: false });
      useSessionStore.setState({ settings, accounts: state.accounts, backendAvailable: true,
        providerOptions: applyRustOptionMirrors(useSessionStore.getState().providerOptions, settings) });
      setState(state);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [host]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!host) return;
    startMediaPolling({ pauseWhenHidden: true });
    return stopMediaPolling;
  }, [host]);

  return <div className="daemon-shell">
    {error && <div role="alert" className="errorbox daemon-error">{error}</div>}
    {!host ? <main className="daemon-home">
      <h1>{t("daemon.title")}</h1>
      <p className="muted">{t("daemon.pairing")}</p>
    </main> : <>
      {!settingsOpen && <main className="daemon-home">
        <header className="daemon-app-header"><div><span className="daemon-brand">LILO</span>
          <h1>{page === "voice" ? t("daemon.voiceTab") : t("music.title")}</h1></div>
          <Button small onClick={() => void load()}>{t("daemon.refresh")}</Button>
        </header>
      <VoiceSessionControl voice={voice}/>
        {page === "voice" && state && <VoicePanel voice={voice} accounts={state.accounts} available={state.voiceAvailable}/>}
        {page === "music" && <div className="daemon-music"><MediaPlayer/><MusicSearch/></div>}
      </main>}
      {!settingsOpen && <nav className="daemon-app-nav" aria-label={t("daemon.navigation")}>
        <button type="button" aria-current={page === "voice" ? "page" : undefined} onClick={() => setPage("voice")}><MicIcon/><span>{t("daemon.voiceTab")}</span></button>
        <button type="button" aria-current={page === "music" ? "page" : undefined} onClick={() => setPage("music")}><WaveIcon/><span>{t("music.title")}</span></button>
        <button type="button" onClick={() => setSettingsOpen(true)}><SettingsIcon/><span>{t("settings.title")}</span></button>
      </nav>}
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        pageIds={DAEMON_PAGE_IDS}
        extraPages={DEVICE_PAGES}
        compactNavigation
        sessionControl={<VoiceSessionControl voice={voice}/>}
      />
    </>}
    <Toast/>
  </div>;
}
