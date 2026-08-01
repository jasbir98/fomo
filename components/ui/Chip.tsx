"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";

export type ChipProps = {
  label: ReactNode;
  selected?: boolean;
  /** Material Symbols name rendered before the label. */
  leadingIcon?: string;
  onClick?: () => void;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick">;

/**
 * Selectable pill chip. Active = navy fill; idle = surface-container tint.
 * Used for interests, dietary, mode chips, filters.
 */
export function Chip({
  label,
  selected = false,
  leadingIcon,
  onClick,
  className = "",
  type = "button",
  ...props
}: ChipProps) {
  return (
    <button
      type={type}
      aria-pressed={selected}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-4 min-h-[36px] text-label-md font-medium whitespace-nowrap transition-colors ${
        selected
          ? "bg-primary text-on-primary border border-primary shadow-sm"
          : "bg-surface-container text-on-surface-variant border border-transparent hover:bg-surface-container-high"
      } ${className}`}
      {...props}
    >
      {leadingIcon ? <Icon name={leadingIcon} size={18} filled={selected} /> : null}
      {label}
    </button>
  );
}

export default Chip;
