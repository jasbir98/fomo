"use client";

import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";
import { Icon } from "./Icon";

export type InputProps = {
  label?: ReactNode;
  error?: string;
  helperText?: string;
  /** Material Symbols name shown inside the field, leading edge. */
  leadingIcon?: string;
} & InputHTMLAttributes<HTMLInputElement>;

/**
 * Text input with a persistent label above the field (never placeholder-only).
 * 12px radius, 2px navy focus ring, error state.
 */
export function Input({
  label,
  error,
  helperText,
  leadingIcon,
  id,
  className = "",
  ...props
}: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedBy = error ? `${inputId}-error` : helperText ? `${inputId}-help` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={inputId} className="text-label-md text-on-surface-variant font-medium">
          {label}
        </label>
      ) : null}
      <div className="relative">
        {leadingIcon ? (
          <Icon
            name={leadingIcon}
            size={20}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
          />
        ) : null}
        <input
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`w-full min-h-[48px] rounded-md bg-surface-container-lowest text-body-md text-on-surface placeholder:text-outline border transition-colors focus:outline-none focus:ring-2 ${
            leadingIcon ? "pl-10 pr-3" : "px-3"
          } ${
            error
              ? "border-error focus:border-error focus:ring-error/30"
              : "border-outline-variant focus:border-primary focus:ring-primary/30"
          } ${className}`}
          {...props}
        />
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="text-label-sm text-error font-medium">
          {error}
        </p>
      ) : helperText ? (
        <p id={`${inputId}-help`} className="text-label-sm text-on-surface-variant">
          {helperText}
        </p>
      ) : null}
    </div>
  );
}

export default Input;
