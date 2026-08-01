import type { ReactNode } from "react";
import { Icon } from "./Icon";

export type StatusTone = "success" | "info" | "warning" | "error" | "neutral";

export type StatusPillProps = {
  label: ReactNode;
  tone?: StatusTone;
  /** Optional leading Material Symbols icon name. */
  icon?: string;
  className?: string;
};

// Per DESIGN: success/info tinted with navy, warning = orange, error = red.
const TONE: Record<StatusTone, string> = {
  success: "bg-primary-fixed text-on-primary-fixed",
  info: "bg-primary-fixed text-on-primary-fixed",
  warning: "bg-secondary-container/25 text-secondary",
  error: "bg-error-container text-on-error-container",
  neutral: "bg-surface-container text-on-surface-variant",
};

/**
 * Small status/badge pill (e.g. "Quiet now", "Rain expected").
 */
export function StatusPill({ label, tone = "neutral", icon, className = "" }: StatusPillProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-label-sm font-semibold whitespace-nowrap ${TONE[tone]} ${className}`}
    >
      {icon ? <Icon name={icon} size={14} filled /> : null}
      {label}
    </span>
  );
}

export default StatusPill;
