import { useEffect, useState } from "react";

import {
  IDLE_STATES,
  isWakeWordSupported,
  useNativeEngine,
} from "../voice/useWakeWord";
import { openExternal, wakeWatchState } from "../../lib/gateway";
import {
  DEFAULT_GREETING,
  DEFAULT_PERSONA,
  effectiveGreeting,
  effectivePersona,
  languageKey,
} from "../../store/preferencesStore";
import { useDraftPreference, useSettingsDraft } from "../../store/settingsDraft";
import { describeWakeBlock, useWakeStore } from "../../store/wakeStore";
import { useSessionStore } from "../../store/sessionStore";
import { useTranslation, type TranslationKey } from "../../i18n";
import { Switch, TextField } from "../../shared/ui/controls";
import { Button, Section } from "../../shared/ui/primitives";

const STATUS_CHIPS: ReadonlyArray<{
  when: (flags: {
    blocked: boolean;
    supported: boolean;
    enabled: boolean;
    idle: boolean;
    alive: boolean | null;
  }) => boolean;
  className: string;
  labelKey: TranslationKey;
}> = [
  {
    when: ({ blocked, enabled }) => blocked && enabled,
    className: "status-chip bad",
    labelKey: "wake.blocked",
  },
  {
    when: ({ supported }) => !supported,
    className: "status-chip bad",
    labelKey: "wake.unavailable",
  },
  {
    when: ({ enabled }) => !enabled,
    className: "status-chip",
    labelKey: "wake.off",
  },
  {
    when: ({ idle }) => !idle,
    className: "status-chip",
    labelKey: "wake.inCall",
  },
  {
    when: ({ alive }) => alive === true,
    className: "status-chip ok",
    labelKey: "wake.listening",
  },
  {
    when: ({ alive }) => alive === false,
    className: "status-chip bad",
    labelKey: "wake.notListening",
  },
];

export function WakeWordSection() {
  const { t } = useTranslation();
  const wakeWord = useDraftPreference("wakeWord");
  const wakePhrase = useDraftPreference("wakePhrase");
  const wakeGreeting = useDraftPreference("wakeGreeting");
  const systemPrompt = useDraftPreference("systemPrompt");
  const language = useDraftPreference("language");
  const lang = languageKey(language);
  const greetingText = effectiveGreeting({ wakeGreeting, language });
  const personaText = effectivePersona({ systemPrompt, language });
  const setPreference = useSettingsDraft((s) => s.setPreference);
  const supported = isWakeWordSupported();
  const connectionState = useSessionStore((s) => s.connectionState);
  const native = useNativeEngine();
  const platform = useSessionStore((state) => state.env?.platform) ?? document.documentElement.dataset.os;
  const listenerHint = platform === "macos" ? "wake.listenerDownMac" : platform === "windows" ? "wake.listenerDownWindows" : "wake.listenerDown";
  const idle = IDLE_STATES.has(connectionState);
  const blocked = useWakeStore((s) => s.blocked);
  const blockCopy = blocked ? describeWakeBlock(blocked) : null;

  // The chip must reflect the real listener process, not just the switch:
  // on macOS the helper can be dead (killed before prompting) while enabled.
  const [alive, setAlive] = useState<boolean | null>(null);
  useEffect(() => {
    if (!supported || !wakeWord) {
      setAlive(null);
      return;
    }
    if (!native) {
      setAlive(true);
      return;
    }
    let cancelled = false;
    const check = () => {
      wakeWatchState().then(
        (running) => {
          if (!cancelled) setAlive(running);
        },
        () => {
          if (!cancelled) setAlive(false);
        },
      );
    };
    check();
    const timer = setInterval(check, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [supported, wakeWord, native]);

  const flags = { blocked: !!blockCopy, supported, enabled: wakeWord, idle, alive };
  const chip = STATUS_CHIPS.find((entry) => entry.when(flags));

  return (
    <Section title={t("wake.title")}>
      <div className="row between">
        <span style={{ fontSize: 13, fontWeight: 600 }}>{t("wake.wakeWord")}</span>
        <Switch
          checked={wakeWord && supported}
          onChange={(next) => setPreference("wakeWord", next)}
          label={t("wake.wakeWord")}
        />
      </div>

      {blockCopy && wakeWord && (
        <div className="errorbox">
          <strong>{blockCopy.title}</strong>
          <p className="small" style={{ margin: "6px 0 0" }}>{blockCopy.body}</p>
          {blockCopy.action && (
            <div className="btn-stack" style={{ marginTop: 10 }}>
              <Button
                small
                onClick={() => {
                  void openExternal(blockCopy.action!.url).catch(() => {});
                }}
              >
                {blockCopy.action.label}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="row between">
        <span className="muted small">{t("wake.status")}</span>
        {chip ? (
          <span className={chip.className}>{t(chip.labelKey)}</span>
        ) : (
          <span className="status-chip">{t("wake.starting")}</span>
        )}
      </div>
      {supported && wakeWord && idle && alive === false && (
        <div className="errorbox">{t(listenerHint)}</div>
      )}

      <p className="field-help">{t("wake.help")}</p>

      {!supported && <div className="errorbox">{t("wake.unsupported")}</div>}

      <TextField
        label={t("wake.phrase")}
        value={wakePhrase}
        onChange={(value) => setPreference("wakePhrase", value)}
        placeholder="lilo"
        help={t("wake.phraseHelp")}
      />
      <p className="field-help">{t("wake.endCallHelp")}</p>
      {/* Showing the language default in the field keeps it editable in place;
          typing it back exactly returns to "follow the language". */}
      <TextField
        label={t("wake.greeting")}
        value={greetingText}
        onChange={(value) =>
          setPreference("wakeGreeting", value === DEFAULT_GREETING[lang] ? null : value)
        }
        multiline
        rows={2}
        help={t("wake.greetingHelp")}
      />
      {wakeGreeting !== null && (
        <div className="btn-stack">
          <Button small onClick={() => setPreference("wakeGreeting", null)}>
            {t("wake.useDefault")}
          </Button>
        </div>
      )}
      <TextField
        label={t("wake.systemPrompt")}
        value={personaText}
        onChange={(value) =>
          setPreference("systemPrompt", value === DEFAULT_PERSONA[lang] ? null : value)
        }
        multiline
        rows={3}
        help={t("wake.systemPromptHelp")}
      />
      {systemPrompt !== null && (
        <div className="btn-stack">
          <Button small onClick={() => setPreference("systemPrompt", null)}>
            {t("wake.useDefault")}
          </Button>
        </div>
      )}

      <div className="notice">{t("wake.micNotice")}</div>
    </Section>
  );
}