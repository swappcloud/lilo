import { useEffect, useRef, useState } from "react";

import {
  cancelPhoneLogin,
  startPhoneLogin,
  stopPhoneLogin,
  type PhoneLoginInfo,
} from "../../lib/gateway";
import { providerLogin, providerMeta, type ProviderId } from "../../providers";
import { accentColors, usePreferencesStore } from "../../store/preferencesStore";
import { toast } from "../../store/toastStore";
import { useTranslation } from "../../i18n";
import { Button } from "../../shared/ui/primitives";
import { SelectField } from "../../shared/ui/controls";

/** Clipboard fallback for environments where the async API is unavailable. */
function fallbackCopy(text: string, done: () => void): void {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
    done();
  } finally {
    document.body.removeChild(area);
  }
}

/**
 * "Sign in with phone" pairing sheet.
 *
 * Starts the LAN helper server, shows the QR code + URL, and waits. When the
 * phone posts its session, the backend emits the backend's own sign-in status
 * (the global store listener switches provider + refreshes accounts); here we
 * just toast and close. Which backend that is comes from the caller: phone
 * login is a declared capability, not an assumption about ChatGPT.
 */
export function PhoneLoginSheet({
  provider,
  onClose,
}: {
  provider: ProviderId;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<PhoneLoginInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedUrl, setSelectedUrl] = useState("");
  const address = info?.addresses?.find((choice) => choice.url === selectedUrl) ?? info;
  const backend = providerMeta(provider).shortLabel;

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const doneRef = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;

  const copyUrl = () => {
    if (!address) return;
    const url = address.url;
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(url).then(done, () => fallbackCopy(url, done));
      return;
    }
    fallbackCopy(url, done);
  };

  useEffect(() => {
    let cancelled = false;
    const accent = accentColors(usePreferencesStore.getState());
    startPhoneLogin(provider, [accent.from, accent.to]).then(
      (result) => {
        if (!cancelled) setInfo(result);
      },
      (err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      },
    );
    let off: (() => void) | undefined;
    void providerLogin(provider)?.onStatus((status) => {
      if (status.status === "ok") {
        doneRef.current = true;
        toast(tRef.current("phone.signedIn", { email: status.email ?? "phone" }));
        closeRef.current();
      }
    })?.then((unlisten) => {
      off = unlisten;
    });
    return () => {
      cancelled = true;
      off?.();
      // Success keeps the hidden login window as the backend's transport;
      // cancel closes a half-done one.
      const stop = doneRef.current ? stopPhoneLogin : cancelPhoneLogin;
      void stop().catch(() => {});
    };
  }, [provider]);

  return (
    <div className="overlay" onClick={() => closeRef.current()}>
      <div
        className="sheet"
        role="dialog"
        aria-label={t("phone.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <h3>{t("phone.title")}</h3>
        {error ? (
          <div className="errorbox">{error}</div>
        ) : !info ? (
          <p className="muted small">{t("phone.starting")}</p>
        ) : (
          <>
            <p className="muted small">
              {t("phone.sameWifi")}
            </p>
            {address?.qrSvg && (
              <div
                className="qr"
                dangerouslySetInnerHTML={{ __html: address.qrSvg }}
              />
            )}
            <div className="row between">
              <code className="url">{address?.url}</code>
              <Button small onClick={copyUrl}>
                {copied ? t("phone.copied") : t("phone.copy")}
              </Button>
            </div>
            {info.addresses?.length > 1 && (
              <SelectField
                label={t("phone.network")}
                value={address?.url ?? info.url}
                options={info.addresses.map((choice) => ({ value: choice.url, label: choice.label }))}
                onChange={(url) => { setSelectedUrl(url); setCopied(false); }}
                help={t("phone.networkHelp")}
              />
            )}
            {info.windowsFirewall && (
              <div className="notice">{t("phone.windowsFirewall")}</div>
            )}
            <ol className="steps">
              <li>{t("phone.step1", { backend })}</li>
              <li>{t("phone.step2", { backend })}</li>
              <li>{t("phone.step3", { backend })}</li>
            </ol>
            <p className="muted small">{t("phone.noApps")}</p>
            <div className="row between">
              <span className="muted small">{t("phone.waiting")}</span>
              <Button small onClick={() => closeRef.current()}>
                {t("phone.cancel")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
