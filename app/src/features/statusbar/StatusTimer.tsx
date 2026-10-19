import { useEffect, useRef, useState } from "react";

import { summaryOf } from "../../lib/toolResult";
import { ClockIcon } from "../../shared/ui/icons";
import { renderStatus, useStatusbarStore } from "../../store/statusbarStore";
import { useSessionStore } from "../../store/sessionStore";
import { toast } from "../../store/toastStore";

export function StatusTimer() {
  const item = useStatusbarStore((s) => s.item);
  const runTool = useSessionStore((s) => s.runTool);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const ticking = item?.endsAt != null;
  useEffect(() => {
    if (!ticking) return;
    setNow(Math.floor(Date.now() / 1000));
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!item) setOpen(false);
  }, [item]);

  if (!item) return null;

  const run = async (tool: string, args: unknown) => {
    setBusy(true);
    try {
      const summary = summaryOf(
        await runTool(tool, (args && typeof args === "object" ? args : {}) as Record<string, unknown>),
      );
      if (summary) toast(summary);
      setOpen(false);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const text = renderStatus(item, now);
  const hasActions = item.actions.length > 0;

  return (
    <div className="status-timer" ref={rootRef}>
      <button
        type="button"
        className={`topchip status-timer-chip${open ? " on" : ""}`}
        aria-haspopup={hasActions ? "menu" : undefined}
        aria-expanded={hasActions ? open : undefined}
        onClick={() => hasActions && setOpen((value) => !value)}
      >
        <ClockIcon size={13} />
        <b>{text}</b>
      </button>
      {open && (
        <div className="status-timer-menu glass" role="menu">
          {item.actions.map((action) => (
            <button
              key={action.tool + action.label}
              type="button"
              role="menuitem"
              className="status-timer-item"
              disabled={busy}
              onClick={() => void run(action.tool, action.args)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
