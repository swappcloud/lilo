import { useMemo, useState } from "react";

import { relativeTime } from "../../shared/lib/format";
import { spokenIn, useSessionStore, type Conversation } from "../../store/sessionStore";
import { useTranslation } from "../../i18n";
import { Button, SlidePanel } from "../../shared/ui/primitives";
import { PencilIcon, PlusIcon, TrashIcon } from "../../shared/ui/icons";
import { isProviderId, providerMeta } from "../../providers";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Show the selected conversation's transcript right away. */
  onOpenTranscript: () => void;
}

type Group = "today" | "yesterday" | "week" | "earlier";

const DAY_MS = 86_400_000;

/** Which heading a conversation falls under, by its last activity. */
function groupOf(timestamp: number, now = new Date()): Group {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= midnight) return "today";
  if (timestamp >= midnight - DAY_MS) return "yesterday";
  if (timestamp >= midnight - 6 * DAY_MS) return "week";
  return "earlier";
}

/** The last thing said, so a row shows where the conversation stopped. */
function previewOf(conversation: Conversation): string | null {
  const spoken = spokenIn(conversation);
  return spoken.length > 0 ? spoken[spoken.length - 1].text.trim() : null;
}

export function ConversationRail({ open, onClose, onOpenTranscript }: Props) {
  const { t } = useTranslation();
  const conversations = useSessionStore((s) => s.conversations);
  const activeId = useSessionStore((s) => s.activeId);
  const selectConversation = useSessionStore((s) => s.selectConversation);
  const newConversation = useSessionStore((s) => s.newConversation);
  const deleteConversation = useSessionStore((s) => s.deleteConversation);
  const renameConversation = useSessionStore((s) => s.renameConversation);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** Row asking to be deleted. Inline, because the webview has no real
   *  `window.confirm` — a native dialog would silently swallow the click. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const groups = useMemo(() => {
    const ordered = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    const byGroup = new Map<Group, Conversation[]>();
    for (const conversation of ordered) {
      const group = groupOf(conversation.updatedAt);
      byGroup.set(group, [...(byGroup.get(group) ?? []), conversation]);
    }
    return [...byGroup.entries()];
  }, [conversations]);

  const startRename = (conversation: Conversation) => {
    setEditingId(conversation.id);
    setDraft(conversation.title);
  };
  const commitRename = () => {
    if (editingId) renameConversation(editingId, draft);
    setEditingId(null);
  };

  return (
    <SlidePanel
      title={t("conversations.title")}
      side="left"
      open={open}
      onClose={onClose}
      headerExtra={<span className="muted small mono">{conversations.length}</span>}
      footer={
        <Button variant="primary" onClick={newConversation}>
          <PlusIcon /> {t("conversations.new")}
        </Button>
      }
    >
      <div className="rail">
        <p className="rail-help muted small">{t("conversations.help")}</p>
        {groups.map(([group, items]) => (
          <section key={group} className="set-group">
            <h3 className="sec">{t(`conversations.${group}`)}</h3>
            <div className="set-card rail-card">
            {items.map((conversation) => {
              const preview = previewOf(conversation);
              return (
                <div
                  key={conversation.id}
                  className={`conv${conversation.id === activeId ? " on" : ""}`}
                >
                  {confirmingId === conversation.id ? (
                    <div className="conv-confirm">
                      <span className="conv-confirm-text">{t("conversations.deletePrompt")}</span>
                      <span className="conv-confirm-actions">
                        <button className="btn small ghost" onClick={() => setConfirmingId(null)}>
                          {t("common.cancel")}
                        </button>
                        <button
                          className="btn small danger"
                          onClick={() => {
                            deleteConversation(conversation.id);
                            setConfirmingId(null);
                          }}
                        >
                          {t("conversations.deleteShort")}
                        </button>
                      </span>
                    </div>
                  ) : editingId === conversation.id ? (
                    <input
                      className="conv-rename"
                      autoFocus
                      value={draft}
                      aria-label={t("conversations.rename")}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitRename();
                        if (event.key === "Escape") setEditingId(null);
                      }}
                    />
                  ) : (
                    <>
                      <button
                        className="conv-open"
                        onClick={() => {
                          selectConversation(conversation.id);
                          onOpenTranscript();
                        }}
                        onDoubleClick={() => startRename(conversation)}
                      >
                        <span className="conv-line">
                          <span className="conv-title">{conversation.title}</span>
                          <span className="conv-time">
                            {relativeTime(conversation.updatedAt, t)}
                          </span>
                        </span>
                        <span className={`conv-preview${preview ? "" : " conv-preview--empty"}`}>
                          {preview ?? t("conversations.noPreview")}
                        </span>
                        {!!Object.keys(conversation.threads ?? {}).length && <span className="conv-providers">
                          {Object.keys(conversation.threads ?? {}).filter(isProviderId).map((id) => <span key={id}>{providerMeta(id).shortLabel}</span>)}
                        </span>}
                      </button>
                      <span className="conv-actions">
                        <button
                          className="conv-action"
                          onClick={() => startRename(conversation)}
                          aria-label={t("conversations.rename")}
                          title={t("conversations.rename")}
                        >
                          <PencilIcon size={15} />
                        </button>
                        <button
                          className="conv-action conv-action--danger"
                          onClick={() => setConfirmingId(conversation.id)}
                          aria-label={t("conversations.delete")}
                          title={t("conversations.deleteShort")}
                        >
                          <TrashIcon size={15} />
                        </button>
                      </span>
                    </>
                  )}
                </div>
              );
            })}
            </div>
          </section>
        ))}
      </div>
    </SlidePanel>
  );
}
