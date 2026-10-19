import { useEffect, useState } from "react";
import { hostPort } from "../../lib/hostPort";
import type { BrowserAction, BrowserFrame } from "../../lib/browserPort";
import type { DaemonNetworkScan, DaemonNetworkStatus } from "./daemonHost";
import { useTranslation } from "../../i18n";
import { useDraftPreference, useSettingsDraft } from "../../store/settingsDraft";
import { SelectField, Switch, TextField } from "../../shared/ui/controls";
import { Button, Section } from "../../shared/ui/primitives";

/** Device controls do not capture phone audio or instantiate a login browser. */
export function DeviceSection() {
  const { t } = useTranslation();
  const host = hostPort();
  const browser = host?.browser;
  const phrase = useDraftPreference("wakePhrase");
  const wakeWord = useDraftPreference("wakeWord");
  const [wakeState, setWakeState] = useState("starting");
  const setPreference = useSettingsDraft(state => state.setPreference);
  const [audio, setAudio] = useState<BrowserFrame["audio"]>();
  const [network, setNetwork] = useState<DaemonNetworkStatus | null>(null);
  const [networks, setNetworks] = useState<DaemonNetworkScan["networks"]>([]);
  const [selectedSsid, setSelectedSsid] = useState("");
  const [password, setPassword] = useState("");
  const [networkBusy, setNetworkBusy] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!host) return;
    let stopped = false;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const status = await host.call<{ state: string } | undefined>("wake_status");
        if (!stopped) setWakeState(status?.state ?? "blocked");
      } catch { if (!stopped) setWakeState("blocked"); }
      finally { busy = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [host]);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void browser?.exchange({ action: "audioStatus" }).then(frame => { if (active) setAudio(frame.audio); }).catch(() => { if (active) setError(t("daemon.audioError")); });
    return () => { active = false; };
  }, [browser, t]);
  useEffect(() => {
    let active = true;
    void host?.call<DaemonNetworkStatus>("network_status").then(status => {
      if (active) setNetwork(status);
    }).catch(() => {
      if (active) setNetworkError(t("daemon.networkStatusError"));
    });
    return () => { active = false; };
  }, [host, t]);
  const test = async (action: BrowserAction) => {
    if (!browser) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const frame = await browser.exchange(action);
      if (frame.phase === "error" || !frame.audio) throw new Error("Audio unavailable.");
      setAudio(frame.audio);
      setResult(frame.audio.microphoneTest ? t("daemon.micResult", { level: Math.round((frame.audio.microphonePeak ?? 0) * 100) }) : t("daemon.speakerResult"));
    } catch { setError(t("daemon.audioError")); }
    finally { setBusy(false); }
  };
  const scan = async () => {
    if (!host || !network?.canScan) return;
    setNetworkBusy(true); setNetworkError(null);
    try {
      const result = await host.call<DaemonNetworkScan>("network_scan");
      setNetworks(result.networks);
      setSelectedSsid(current => result.networks.some(item => item.ssid === current)
        ? current
        : result.networks.some(item => item.ssid === network.currentSsid) ? network.currentSsid! : "");
      setPassword("");
    } catch {
      setNetworkError(t("daemon.networkScanError"));
    } finally { setNetworkBusy(false); }
  };
  const join = async () => {
    if (!host || !network?.canJoin || !selectedSsid) return;
    const selected = networks.find(item => item.ssid === selectedSsid);
    if (!selected) return;
    setNetworkBusy(true); setNetworkError(null);
    try {
      const status = await host.call<DaemonNetworkStatus>("network_join", {
        ssid: selected.ssid,
        password: selected.secured ? password : "",
      });
      setNetwork(status);
      setPassword("");
    } catch {
      setNetworkError(t("daemon.networkJoinError"));
    } finally { setNetworkBusy(false); }
  };
  const selectedNetwork = networks.find(item => item.ssid === selectedSsid);
  return <>
    <Section title={t("daemon.devicePreferences")}>
      <div className="row between"><span>{t("wake.wakeWord")}</span><Switch label={t("wake.wakeWord")} checked={wakeWord} onChange={next => setPreference("wakeWord", next)}/></div>
      <div className="row between"><span>{t("wake.status")}</span><span>{t(wakeState === "listening" ? "wake.listening" : wakeState === "blocked" ? "wake.blocked" : wakeState === "starting" ? "wake.starting" : "wake.off")}</span></div>
      <TextField label={t("wake.phrase")} value={phrase} onChange={next => setPreference("wakePhrase", next)} help={t("daemon.wakeHelp")}/>
      <p className="notice">{t("daemon.voicePending")}</p>
    </Section>
    <Section title={t("daemon.audioTitle")}>
      <p className="field-help">{t("daemon.audioHelp")}</p>
      <p className="notice">{audio?.available ? t("daemon.audioAvailable") : t("daemon.audioUnavailable")}</p>
      <div className="btn-stack">
        <Button disabled={busy || !audio?.outputAvailable} onClick={() => void test({ action: "audioTestSpeaker" })}>{t("daemon.testSpeaker")}</Button>
        <Button disabled={busy || !audio?.inputAvailable} onClick={() => void test({ action: "audioTestMicrophone" })}>{t("daemon.testMicrophone")}</Button>
      </div>
      {result && <p className="notice" role="status">{result}</p>}
      {error && <div className="errorbox" role="alert">{error}</div>}
    </Section>
    <Section title={t("daemon.networkTitle")}>
      <p className="field-help">{t("daemon.networkHelp")}</p>
      <p className="notice" role="status">
        {!network
          ? t("daemon.networkLoading")
          : network.currentSsid
            ? t("daemon.networkConnected", { ssid: network.currentSsid })
            : network.online
              ? t("daemon.networkOnline")
              : network.available
                ? t("daemon.networkOffline")
                : t("daemon.networkUnavailable")}
      </p>
      {network?.available && !network.hasRadio && <p className="notice">{t("daemon.networkNoRadio")}</p>}
      <div className="btn-stack">
        <Button disabled={networkBusy || !network?.canScan} onClick={() => void scan()}>
          {networkBusy ? t("daemon.networkWorking") : t("daemon.networkScan")}
        </Button>
      </div>
      {networks.length > 0 && <>
        <SelectField
          label={t("daemon.networkSelect")}
          value={selectedSsid}
          disabled={networkBusy}
          placeholder={t("daemon.networkChoose")}
          options={networks.map(item => ({
            value: item.ssid,
            label: `${item.ssid} · ${item.signal}% · ${item.secured ? t("daemon.networkSecured") : t("daemon.networkOpen")}`,
          }))}
          onChange={next => { setSelectedSsid(next); setPassword(""); }}
        />
        {selectedNetwork?.secured && <TextField
          label={t("daemon.networkPassword")}
          type="password"
          value={password}
          disabled={networkBusy}
          onChange={setPassword}
        />}
        {selectedNetwork?.secured && <p className="notice" role="status">{t("daemon.networkCredentialNotice")}</p>}
        {selectedNetwork && !selectedNetwork.secured && <p className="notice">{t("daemon.networkOpenWarning")}</p>}
        <div className="btn-stack">
          <Button
          disabled={networkBusy || !network?.canJoin || !selectedNetwork || (selectedNetwork.secured && !password)}
            onClick={() => void join()}
          >{networkBusy ? t("daemon.networkWorking") : t("daemon.networkJoin")}</Button>
        </div>
      </>}
      {networkError && <div className="errorbox" role="alert">{networkError}</div>}
    </Section>
  </>;
}
