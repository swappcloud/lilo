import { usePluginsStore } from "../../store/pluginsStore";
import { hostPort } from "../../lib/hostPort";
import { useState } from "react";

import {
  loginProviderIds,
  providerLogin,
  providerMeta,
  type ProviderId,
} from "../../providers";
import { useSessionStore } from "../../store/sessionStore";
import { toast } from "../../store/toastStore";
import { useTranslation, type Translate } from "../../i18n";
import { TextField } from "../../shared/ui/controls";
import { Button, Section } from "../../shared/ui/primitives";
import { PhoneLoginSheet } from "./PhoneLoginSheet";
import { BrowserSignInSheet } from "./BrowserSignInSheet";
import { ProviderStatusBadge } from "./ProviderStatusBadge";

function initials(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  const clean = email.replace(/[^a-z0-9]/gi, "");
  return (clean.slice(0, 2) || "?").toUpperCase();
}

/** "plus" → "Plus"; the provider's own word, only capitalized. */
function planLabel(plan: string | null | undefined): string | null {
  const word = plan?.trim();
  return word ? word[0].toUpperCase() + word.slice(1) : null;
}

function formatExpiry(
  expiresAt: number | null | undefined,
  t: Translate,
): { label: string; soon: boolean } | null {
  if (!expiresAt) return null;
  const msLeft = expiresAt * 1000 - Date.now();
  const days = Math.floor(msLeft / 86_400_000);
  const date = new Date(expiresAt * 1000).toLocaleDateString();
  if (msLeft <= 0) return { label: t("account.sessionExpired", { date }), soon: true };
  if (days >= 2) {
    return { label: t("account.sessionValidUntil", { date }), soon: false };
  }
  const hours = Math.max(1, Math.floor(msLeft / 3_600_000));
  return {
    label:
      days >= 1
        ? t("account.sessionExpiresDays", { days, date })
        : t("account.sessionExpiresHours", { hours, date }),
    soon: true,
  };
}

/**
 * Every signed-in backend, plus a sign-in button for each backend still
 * missing one — all driven by the provider registry, so a new backend shows
 * up here without touching this file.
 */
export function AccountSection() {
  usePluginsStore((state) => state.plugins);
  const { t } = useTranslation();
  const accounts = useSessionStore((s) => s.accounts);
  const backendAvailable = useSessionStore((s) => s.backendAvailable);
  const loginStatus = useSessionStore((s) => s.loginStatus);
  const loginProvider = useSessionStore((s) => s.loginProvider);
  const loginMessage = useSessionStore((s) => s.loginMessage);
  const startLogin = useSessionStore((s) => s.startLogin);
  const cancelLogin = useSessionStore((s) => s.cancelLogin);
  const refreshProfile = useSessionStore((s) => s.refreshProfile);
  const removeAccount = useSessionStore((s) => s.removeAccount);
  const addAccount = useSessionStore((s) => s.addAccount);

  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The backend whose phone pairing is open, if any. */
  const [phoneProvider, setPhoneProvider] = useState<ProviderId | null>(null);

  const loginIds = loginProviderIds();
  const accountFor = (id: ProviderId) =>
    accounts.find((a) => a.provider === id && a.status === "ok");
  const missing = loginIds.filter((id) => !accountFor(id));
  const waiting = loginStatus === "waiting";
  const browser = hostPort()?.browser;
  const signIn = (id: ProviderId) => browser?.supports(id) ? setPhoneProvider(id) : void startLogin(id);
  /** The backend that offers the paste-a-session fallback, if any. */
  const pasteProvider = loginIds.find(
    (id) => !hostPort() && providerLogin(id)?.manualPaste,
  );

  const submitManual = async () => {
    setError(null);
    setBusy(true);
    try {
      await addAccount(email.trim(), token.trim());
      setToken("");
      toast(t("account.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="notice">{t("account.serviceNotice")}</p>
      {!backendAvailable && !loginIds.some(id => browser?.supports(id)) && (
        <Section title={t("account.title")}><div className="notice">{t(hostPort() ? "daemon.loginPending" : "account.needsDesktop")}</div></Section>
      )}

      {loginIds.map((id) => {
        const account = accountFor(id);
        if (!account) return null;
        const meta = providerMeta(id);
        const expiry = formatExpiry(account.expiresAt, t);
        const plan = planLabel(account.plan);
        return (
          <Section key={id} title={meta.shortLabel} status={<ProviderStatusBadge provider={meta} />}>
          <div className="account">
            <div className="row">
              <div className="avatar">
                {initials(account.name ?? "", account.email)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <b>{account.name?.trim() || account.email}</b>
                  <span className="status-chip">
                    <meta.icon size={11} />
                    {meta.shortLabel}
                  </span>
                  {plan && (
                    <span className="status-chip" title={t("account.planHelp")}>
                      {t("account.plan", { plan })}
                    </span>
                  )}
                </div>
                <small>
                  {account.name?.trim() ? `${account.email} · ` : ""}
                  {account.org ? `org ${account.org} · ` : ""}
                  {account.hasToken
                    ? t("account.signedInToken")
                    : t("account.signedIn")}
                </small>
              </div>
            </div>
            {expiry && (
              <p
                className={expiry.soon ? "notice" : "field-help"}
                style={{ marginTop: 10 }}
              >
                {expiry.label}
                {expiry.soon && t("account.expiryAction")}
              </p>
            )}
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <Button small disabled={!backendAvailable && !browser?.supports(id)} onClick={() => signIn(id)}>
                {t("account.switch")}
              </Button>
              <Button small disabled={!backendAvailable} onClick={() => void refreshProfile(id)}>
                {t("account.refresh")}
              </Button>
              <Button small onClick={() => void removeAccount(id, account.email)}>
                {t("account.signOut")}
              </Button>
            </div>
          </div>
          </Section>
        );
      })}

      {missing.map((id) => {
        const meta = providerMeta(id);
        const active = loginProvider === id;
        return (
          <Section key={id} title={meta.shortLabel} status={<ProviderStatusBadge provider={meta} />}>
            {meta.releaseStage === "beta" && (
              <div className="notice">{t("provider.betaNotice", { backend: meta.shortLabel })}</div>
            )}
            <div className="btn-stack">
              <Button
                variant="primary"
                disabled={(!backendAvailable && !browser?.supports(id)) || waiting}
                onClick={() => signIn(id)}
              >
                {waiting && active ? t("account.waiting") : <><meta.icon size={14} />{t("account.signInWith", { backend: meta.shortLabel })}</>}
              </Button>
              {meta.capabilities.phoneLogin && !browser?.supports(id) && (
                <Button disabled={!backendAvailable || waiting} onClick={() => setPhoneProvider(id)}>
                  {t("account.signInPhoneWith", { backend: meta.shortLabel })}
                </Button>
              )}
            </div>
            {hostPort() && !browser?.supports(id) && <p className="field-help">{t("daemon.unsupportedLogin")}</p>}
            {waiting && active && (
              <div className="row between">
                <span className="muted small">{t("account.finishLogin", { backend: meta.shortLabel })}</span>
                <button className="btn ghost small" onClick={() => void cancelLogin()}>{t("account.cancel")}</button>
              </div>
            )}
            {active && loginStatus === "error" && loginMessage && <div className="errorbox">{loginMessage}</div>}
            {pasteProvider === id && (
        <details className="disclosure">
          <summary>{t("account.pasteFallback")}</summary>
          <div className="stack">
            <TextField
              label={t("account.emailLabel")}
              value={email}
              onChange={setEmail}
              placeholder={t("account.emailPlaceholder")}
            />
            <TextField
              label={t("account.sessionLabel")}
              value={token}
              onChange={setToken}
              multiline
              placeholder='{"user":{…},"accessToken":"eyJhbGciOi…"}'
              help={t("account.sessionHelp")}
            />
            {error && <div className="errorbox">{error}</div>}
            <Button onClick={() => void submitManual()} disabled={busy || !token}>
              {t("account.saveSession")}
            </Button>
          </div>
        </details>
            )}
          </Section>
        );
      })}

      {phoneProvider && (
        browser?.supports(phoneProvider) ? <BrowserSignInSheet browser={browser} provider={phoneProvider} onClose={() => setPhoneProvider(null)}/> : <PhoneLoginSheet
          provider={phoneProvider}
          onClose={() => setPhoneProvider(null)}
        />
      )}
    </>
  );
}
