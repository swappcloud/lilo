import type { ButtonHTMLAttributes, ReactNode } from "react";

import { useTranslation } from "../../i18n";
import { CloseIcon } from "./icons";
import { CardHeader } from "./CardHeader";
import { useWindowDrag } from "../hooks/useWindowDrag";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost";
  small?: boolean;
}

export function Button({
  variant = "ghost",
  small = false,
  className = "",
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`btn ${variant}${small ? " small" : ""} ${className}`.trim()}
      {...rest}
    />
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  /** Shows a small dot: something inside needs the user's attention. */
  alert?: boolean;
}

export function IconButton({
  label,
  active = false,
  alert = false,
  className = "",
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      className={`iconbtn${active ? " is-active" : ""} ${className}`.trim()}
      aria-label={alert ? `${label} — action required` : label}
      title={label}
      {...rest}
    >
      {children}
      {alert && <i className="iconbtn-dot" aria-hidden />}
    </button>
  );
}

interface SlidePanelProps {
  wide?: boolean;
  title: string;
  open: boolean;
  onClose: () => void;
  side?: "left" | "right";
  headerExtra?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

/** Generic glass slide-over used by every panel (DRY). */
export function SlidePanel({
  wide = false,
  title,
  open,
  onClose,
  side = "right",
  headerExtra,
  footer,
  children,
}: SlidePanelProps) {
  const { t } = useTranslation();
  const drag = useWindowDrag();
  return (
    <aside
      className={`panel glass ${wide ? "panel--wide" : ""} ${side === "left" ? "panel--left" : ""} ${
        open ? "open" : ""
      }`.trim()}
      aria-hidden={!open}
    >
      <header onPointerDown={drag}>
        <h2>{title}</h2>
        {headerExtra}
        <IconButton label={t("common.close")} onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </header>
      {children}
      {footer ? <footer>{footer}</footer> : null}
    </aside>
  );
}

interface SectionProps {
  title: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}

export function Section({ title, status, children }: SectionProps) {
  return (
    <section className="set-group">
      {!status && <div className="sec">{title}</div>}
      <div className="set-card">{status && <CardHeader title={title} status={status} />}{children}</div>
    </section>
  );
}
