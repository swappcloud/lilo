import { useEffect, useState } from "react";
import type { AccountView } from "../../types";
import { useTranslation } from "../../i18n";
import { Button, Section } from "../../shared/ui/primitives";
import type { DaemonVoiceController } from "./useDaemonVoice";
export { mergeVoiceEvents } from "./useDaemonVoice";

function accountKey(account: Pick<AccountView, "provider" | "email">): string {
  return `${account.provider}\u0000${account.email}`;
}

/** Phone controls for a voice session whose microphone and speaker stay on the daemon. */
export function VoicePanel({ voice, accounts, available }: { voice: DaemonVoiceController; accounts: AccountView[]; available: boolean }) {
  const { t } = useTranslation();
  const usableAccounts = accounts.filter(account => account.status === "ok");
  const [selected, setSelected] = useState(() => usableAccounts[0] ? accountKey(usableAccounts[0]) : "");
  const { status, busy, error, active, run, reset } = voice;
  const [text, setText] = useState("");

  useEffect(() => {
    if (!usableAccounts.some(account => accountKey(account) === selected)) {
      setSelected(usableAccounts[0] ? accountKey(usableAccounts[0]) : "");
    }
  }, [accounts, selected]);

  const chosen = usableAccounts.find(account => accountKey(account) === selected);
  const captions = status.events.slice(-12);

  return <Section title={t("daemon.voiceTitle")}>
    <p className="field-help">{t("daemon.voiceHelp")}</p>
    <p className="notice" role="status">{t(`daemon.voiceState.${status.state}`)}</p>
    {status.state === "connected" && <p className="field-help">{status.muted ? t("daemon.voiceMuted") : t("daemon.voiceUnmuted")}</p>}
    {!available && <p className="notice">{t("daemon.voiceUnavailable")}</p>}
    {usableAccounts.length === 0
      ? <p className="notice">{t("daemon.noAccounts")}</p>
      : <label className="daemon-voice-account">
          <span className="field-label">{t("daemon.voiceAccount")}</span>
          <select className="field" value={selected} disabled={active || busy} onChange={event => setSelected(event.target.value)}>
            {usableAccounts.map(account => <option key={accountKey(account)} value={accountKey(account)}>{account.provider} · {account.email}</option>)}
          </select>
        </label>}
    <div className="daemon-voice-controls">
      {!active
        ? <Button variant="primary" disabled={!available || !chosen || busy} onClick={() => {
            if (!chosen) return;
            reset();
            const resolvedLanguage = navigator.language || document.documentElement.lang || "en-US";
            void run("voiceStart", {
              providerId: chosen.provider,
              email: chosen.email,
              resolvedLanguage: resolvedLanguage.length <= 128 ? resolvedLanguage : undefined,
            });
          }}>{t("daemon.voiceStart")}</Button>
        : <Button variant="primary" disabled={busy} onClick={() => void run("voiceStop")}>{t("daemon.voiceStop")}</Button>}
      <Button disabled={busy || status.state !== "connected"} onClick={() => void run("voiceMute", { muted: !status.muted })}>
        {status.muted ? t("daemon.voiceUnmute") : t("daemon.voiceMute")}
      </Button>
      <Button disabled={busy || status.state !== "connected"} onClick={() => void run("voiceInterrupt")}>{t("daemon.voiceInterrupt")}</Button>
    </div>
    {status.state === "connected" && <form className="daemon-voice-text" onSubmit={event => {
      event.preventDefault();
      const message = text.trim();
      if (!message) return;
      setText("");
      void run("voiceText", { text: message });
    }}>
      <label className="daemon-voice-account">
        <span className="field-label">{t("daemon.voiceTextLabel")}</span>
        <input className="field" value={text} maxLength={2000} onChange={event => setText(event.target.value)} disabled={busy}/>
      </label>
      <Button type="submit" disabled={busy || !text.trim()}>{t("daemon.voiceSendText")}</Button>
    </form>}
    {error && <div className="errorbox" role="alert">{error}</div>}
    {captions.length > 0 && <div className="daemon-voice-captions" aria-live="polite" aria-label={t("daemon.voiceCaptions")}>
      <h2>{t("daemon.voiceCaptions")}</h2>
      <ol>{captions.map(event => <li key={event.sequence} className={`daemon-voice-caption ${event.speaker}`}>
        <strong>{t(`daemon.voiceSpeaker.${event.speaker}`)}</strong>
        <span>{event.text}</span>
      </li>)}</ol>
    </div>}
  </Section>;
}
