import { useEffect, useRef, useState } from "react";
import type { BrowserAction, BrowserFrame, BrowserPort } from "../../lib/browserPort";
import { listAccounts } from "../../lib/gateway";
import { useSessionStore } from "../../store/sessionStore";
import { providerMeta, type ProviderId } from "../../providers";
import { useTranslation } from "../../i18n";
import { Button } from "../../shared/ui/primitives";

/** Phone form presentation; the host adapter drives the real provider page. */
export function BrowserSignInSheet({ browser, provider, onClose }: { browser: BrowserPort; provider: ProviderId; onClose: () => void }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const finished = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;

  const progressError = (next: BrowserFrame): string | null => {
    if (next.phase === "error") return t("daemon.browserError");
    if (next.step !== "error") return null;
    if (next.message === "social") return t("daemon.socialLogin");
    if (next.message === "signup") return t("daemon.accountMissing");
    return next.message || t("daemon.answerError");
  };

  useEffect(() => {
    dialog.current?.showModal();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const accept = async (next: BrowserFrame) => {
      if (stopped) return;
      setFrame(next);
      setError(progressError(next));
      if (next.phase === "connected") {
        finished.current = true;
        useSessionStore.setState({ accounts: await listAccounts() });
        return;
      }
      if (next.phase !== "error") timer = setTimeout(() => void poll(), next.step === "ask" ? 5000 : 2000);
    };
    const poll = async () => {
      if (stopped || finished.current) return;
      if (document.hidden) { timer = setTimeout(() => void poll(), 5000); return; }
      try { await accept(await browser.exchange({ action: "frame" })); }
      catch { if (!stopped) setError(t("daemon.browserError")); }
    };
    void browser.exchange({ action: "start", provider }).then(accept).catch(() => {
      if (!stopped) setError(t("daemon.browserError"));
    }).finally(() => { if (!stopped) setBusy(false); });
    return () => { stopped = true; clearTimeout(timer); dialog.current?.close(); void browser.exchange({ action: "cancel" }).catch(() => {}); };
  }, [browser, provider, t]);

  const send = async (action: BrowserAction) => {
    setBusy(true); setError(null);
    try {
      const next = await browser.exchange(action);
      setFrame(next);
      setError(progressError(next));
      if (next.phase === "connected") {
        finished.current = true;
        useSessionStore.setState({ accounts: await listAccounts() });
      }
    } catch { setError(t("daemon.browserError")); }
    finally { setBusy(false); }
  };
  const ask = frame?.ask;
  const label = ask === "password" ? t("daemon.password") : ask === "code" ? t("daemon.code") : ask === "phone" ? t("daemon.phone") : t("daemon.email");
  const working = !frame || frame.step === "working";
  const asking = !!ask && (frame?.step === "ask" || frame?.step === "error");

  useEffect(() => { setValue(""); }, [ask]);

  return <dialog ref={dialog} className="browser-sheet" aria-label={t("account.signInWith", { backend: providerMeta(provider).shortLabel })} onCancel={() => close.current()}>
    <div className="browser-sheet-content">
      <header className="row between"><h2>{providerMeta(provider).shortLabel}</h2><Button onClick={() => close.current()}>{t("daemon.close")}</Button></header>
      {frame?.origin && <p className="field-help">{frame.origin}</p>}
      {error && <div className="errorbox" role="alert">{error}</div>}
      {frame?.phase === "connected" ? <div className="notice" role="status">{t("daemon.connected")}</div> : <>
        {frame?.phase !== "error" && <p className="notice" role="status">{working ? t("daemon.working") : frame?.step === "challenge" ? t("daemon.challenge") : t("daemon.phoneHelp")}</p>}
        {asking && <form onSubmit={event => { event.preventDefault(); const answer = value; setValue(""); setFrame({ phase: "login", step: "working" }); void send({ action: "answer", field: ask, value: answer }); }}>
          <label className="browser-answer"><span className="field-label">{label}</span><input key={ask} type={ask === "password" ? "password" : ask === "email" ? "email" : ask === "phone" ? "tel" : "text"} inputMode={ask === "email" ? "email" : ask === "phone" ? "tel" : ask === "code" ? "numeric" : "text"} autoComplete={ask === "password" ? "current-password" : ask === "code" ? "one-time-code" : ask === "email" ? "email" : "tel"} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={ask === "code" ? 12 : 256} value={value} onChange={event => setValue(event.target.value)} disabled={busy}/></label>
          <div className="btn-stack"><Button type="submit" variant="primary" disabled={busy || !value}>{t("daemon.continue")}</Button></div>
        </form>}
        {frame?.step === "challenge" && frame.image && <>
          <button className="browser-image" disabled={busy} aria-label={t("daemon.interact")} onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            void send({ action: "click", x: (event.clientX - rect.left) * 430 / rect.width, y: (event.clientY - rect.top) * 740 / rect.height });
          }}><img src={`data:image/jpeg;base64,${frame.image}`} alt={t("daemon.providerPage")} draggable={false}/></button>
        </>}
        {frame?.phase !== "error" && <div className="btn-stack"><Button disabled={busy} onClick={() => void send({ action: "frame" })}>{t("daemon.refresh")}</Button></div>}
      </>}
    </div>
  </dialog>;
}
