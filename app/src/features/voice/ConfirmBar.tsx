import { useEffect, useState } from "react";

import { confirmCommand, isTauri, listCommands } from "../../lib/gateway";
import { useTranslation } from "../../i18n";
import { useConfirmStore } from "../../store/confirmStore";
import { Button } from "../../shared/ui/primitives";
import { CheckIcon, CloseIcon } from "../../shared/ui/icons";

/** Reuse command phrases only while the interface locale remains unchanged. */
let phraseCache: { locale: string; phrases: Map<string, string> } | null = null;

/**
 * Asks before a command that changes something runs.
 *
 * The prompt shows the phrase the user actually said rather than the command
 * id, so "clear my notes" is confirmed as what it is, not as `notes.clear`.
 */
export function ConfirmBar() {
  const { t, locale } = useTranslation();
  const command = useConfirmStore((s) => s.command);
  const clear = useConfirmStore((s) => s.clear);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!command) {
      setPhrase(null);
      return;
    }
    if (phraseCache?.locale === locale) {
      setPhrase(phraseCache.phrases.get(command) ?? null);
      return;
    }
    if (!isTauri()) return;
    let active = true;
    listCommands(locale).then(
      (commands) => {
        if (!active) return;
        phraseCache = { locale, phrases: new Map(
          commands.map((entry) => [entry.name, entry.examples[0] ?? entry.name]),
        ) };
        setPhrase(phraseCache.phrases.get(command) ?? null);
      },
      () => { if (active) setPhrase(null); },
    );
    return () => { active = false; };
  }, [command, locale]);

  if (!command) return null;

  const answer = async (approved: boolean) => {
    setBusy(true);
    try {
      await confirmCommand(command, approved);
    } finally {
      setBusy(false);
      clear();
    }
  };

  return (
    <div className="confirmbar glass" role="alertdialog" aria-label={t("confirm.title")}>
      <span className="confirmbar-text">
        <strong>{t("confirm.title")}</strong>
        <span className="muted small">{phrase ?? command}</span>
      </span>
      <span className="confirmbar-actions">
        <Button small disabled={busy} onClick={() => void answer(false)}>
          <CloseIcon size={13} /> {t("confirm.no")}
        </Button>
        <Button
          small
          variant="primary"
          disabled={busy}
          onClick={() => void answer(true)}
        >
          <CheckIcon size={13} /> {t("confirm.yes")}
        </Button>
      </span>
    </div>
  );
}
