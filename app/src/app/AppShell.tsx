import { useCallback, useRef, useState } from "react";

import { useTranslation } from "../i18n";
import { useAlertStore } from "../store/alertStore";
import { useWakeStore } from "../store/wakeStore";
import { useMenuActions } from "./useMenuActions";

import { ConversationRail } from "../features/conversations/ConversationRail";
import { CommandsPanel } from "../features/commands/CommandsPanel";
import { SettingsPanel } from "../features/settings/SettingsPanel";
import { TranscriptPanel } from "../features/transcript/TranscriptPanel";
import { SceneLayer } from "../features/scene/SceneLayer";
import { StatusTimer } from "../features/statusbar/StatusTimer";
import { ConfirmBar } from "../features/voice/ConfirmBar";
import { ControlDock } from "../features/voice/ControlDock";
import { StatusDot } from "../features/voice/StatusDot";
import { VoiceStage } from "../features/voice/VoiceStage";
import { useAvoidOverlap } from "../shared/hooks/useAvoidOverlap";
import { useKeyboardShortcuts } from "../shared/hooks/useKeyboardShortcuts";
import { useWindowDrag } from "../shared/hooks/useWindowDrag";
import { ChatIcon, ClockIcon, HelpIcon, SettingsIcon } from "../shared/ui/icons";
import { Logo } from "../shared/ui/Logo";
import { IconButton } from "../shared/ui/primitives";
import { Toast } from "../shared/ui/Toast";
import { isProviderId, providerMeta } from "../providers";
import { selectVoiceBudget, useSessionStore } from "../store/sessionStore";

export function AppShell() {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [conversationsOpen, setConversationsOpen] = useState(false);

  const connectionState = useSessionStore((s) => s.connectionState);
  const connect = useSessionStore((s) => s.connect);
  const disconnect = useSessionStore((s) => s.disconnect);
  const lastError = useSessionStore((s) => s.lastError);

  const toggleSession = useCallback(() => {
    if (
      connectionState === "connected" ||
      connectionState === "connecting" ||
      connectionState === "reconnecting"
    ) {
      void disconnect();
    } else {
      void connect();
    }
  }, [connectionState, connect, disconnect]);

  const closeAll = useCallback(() => {
    setTranscriptOpen(false);
    setSettingsOpen(false);
    setConversationsOpen(false);
    setCommandsOpen(false);
  }, []);

  // Drag the window by its titlebar (see `useWindowDrag`).
  const onTopbarPointerDown = useWindowDrag();
  const keysRef = useRef<HTMLParagraphElement>(null);
  // The shortcut hint must never sit on top of the dock, however wide the
  // player makes it.
  useAvoidOverlap(keysRef, ".dock");

  useKeyboardShortcuts({
    onToggleSession: toggleSession,
    onToggleTranscript: () => setTranscriptOpen((open) => !open),
    onToggleSettings: () => setSettingsOpen((open) => !open),
    onToggleConversations: () => setConversationsOpen((open) => !open),
    onToggleCommands: () => setCommandsOpen((open) => !open),
    onEscape: closeAll,
  });

  // The native menus (menu bar, tray) open the same panels as the topbar.
  useMenuActions({
    settings: () => setSettingsOpen(true),
    conversations: () => setConversationsOpen(true),
    transcript: () => setTranscriptOpen(true),
    commands: () => setCommandsOpen(true),
  });

  // The gear advertises that something inside needs the user's attention, so
  // a missing microphone permission is not a silent failure.
  const micNeedsPermission = useAlertStore((s) => s.micNeedsPermission);
  const wakeBlocked = useWakeStore((s) => s.blocked);
  const settingsAlert = micNeedsPermission || !!wakeBlocked;

  const budgetSeconds = useSessionStore(selectVoiceBudget);
  const budgetMinutes =
    budgetSeconds === null ? null : Math.max(0, Math.round(budgetSeconds / 60));
  const providerId = useSessionStore((s) => s.providerId);
  const reportsUsage = isProviderId(providerId) && providerMeta(providerId).capabilities.usage;
  return (
    <>
      <div className="aurora" aria-hidden>
        <i className="b1" />
        <i className="b2" />
        <i className="b3" />
      </div>
      <div className="grain" aria-hidden />
      <SceneLayer />

      <header
        className="topbar glass"
        onPointerDown={onTopbarPointerDown}
      >
        <div className="brand">
          <Logo size={28} />
          <span className="brand-name">LILO</span>
        </div>
        <div className="spacer" />
        <StatusTimer />
        {/* The voice budget: a fixed part of the chrome, so it cannot scroll
            away with a caption. Until a session reports one it says so. */}
        {reportsUsage && (
          <div
            className={budgetMinutes === null ? "topchip is-idle" : "topchip"}
            title={
              budgetMinutes === null
                ? t("shell.budgetUnknown")
                : t("session.budget", { minutes: budgetMinutes })
            }
          >
            <ClockIcon size={13} />
            <b>
              {budgetMinutes === null
                ? t("shell.budgetIdle")
                : t("shell.budgetChip", { minutes: budgetMinutes })}
            </b>
          </div>
        )}
        <IconButton
          label={t("nav.conversations")}
          active={conversationsOpen}
          onClick={() => setConversationsOpen((open) => !open)}
        >
          <ChatIcon size={19} />
        </IconButton>
        <IconButton
          label={t("nav.commands")}
          active={commandsOpen}
          onClick={() => setCommandsOpen((open) => !open)}
        >
          <HelpIcon />
        </IconButton>
        <IconButton
          label={t("nav.settings")}
          active={settingsOpen}
          alert={settingsAlert}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <SettingsIcon />
        </IconButton>
      </header>

      <VoiceStage />

      {lastError && <div className="errorbox floating-error">{lastError}</div>}

      <ControlDock
        transcriptOpen={transcriptOpen}
        onToggleTranscript={() => setTranscriptOpen((open) => !open)}
      />

      <p className="keys" ref={keysRef}>
        {t("shell.keys")}
      </p>

      <TranscriptPanel open={transcriptOpen} onClose={() => setTranscriptOpen(false)} />
      <ConversationRail
        open={conversationsOpen}
        onClose={() => setConversationsOpen(false)}
        onOpenTranscript={() => setTranscriptOpen(true)}
      />
      <CommandsPanel open={commandsOpen} onClose={() => setCommandsOpen(false)} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <ConfirmBar />

      {/* State lives in the corner and speaks only on hover: it must not
          compete with the brand for attention. */}
      <StatusDot />

      <Toast />
    </>
  );
}