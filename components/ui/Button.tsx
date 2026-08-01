"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";

export type ButtonVariant = "orange" | "navy" | "outline" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

export type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Material Symbols name rendered before the label. */
  leadingIcon?: string;
  /** Material Symbols name rendered after the label. */
  trailingIcon?: string;
  children?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>;

const VARIANT: Record<ButtonVariant, string> = {
  orange:
    "bg-secondary-container text-on-secondary-container shadow-sm hover:opacity-90 active:opacity-80",
  navy: "bg-primary text-on-primary shadow-sm hover:bg-primary-container active:opacity-90",
  outline:
    "border-[1.5px] border-primary text-primary bg-transparent hover:bg-primary/5 active:bg-primary/10",
  ghost: "bg-transparent text-primary hover:bg-surface-container active:bg-surface-container-high",
  danger: "bg-error text-on-error shadow-sm hover:opacity-90 active:opacity-80",
};

/**
 * Primary CTA button. Navy or Sunset-Orange fill depending on screen, plus
 * outline (1.5px navy) and ghost secondary styles. Pill radius, ≥48px tall.
 */
export function Button({
  variant = "orange",
  size = "md",
  fullWidth = false,
  leadingIcon,
  trailingIcon,
  children,
  className = "",
  type = "button",
  disabled,
  ...props
}: ButtonProps) {
  const sizeCls =
    size === "sm" ? "min-h-[40px] px-4 text-label-md" : "min-h-[48px] px-6 text-label-md";
  return (
    <button
      type={type}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all disabled:opacity-40 disabled:pointer-events-none ${sizeCls} ${VARIANT[variant]} ${fullWidth ? "w-full" : ""} ${className}`}
      {...props}
    >
      {leadingIcon ? <Icon name={leadingIcon} size={18} /> : null}
      {children}
      {trailingIcon ? <Icon name={trailingIcon} size={18} /> : null}
    </button>
  );
}

export default Button;
