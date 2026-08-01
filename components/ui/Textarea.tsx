"use client";

import type { TextareaHTMLAttributes, ReactNode } from "react";
import { useId } from "react";

export type TextareaProps = {
  label?: ReactNode;
  error?: string;
  helperText?: string;
} & TextareaHTMLAttributes<HTMLTextAreaElement>;

/**
 * Multi-line input with a persistent label above the field.
 * 12px radius, 2px navy focus ring, error state.
 */
export function Textarea({
  label,
  error,
  helperText,
  id,
  rows = 4,
  className = "",
  ...props
}: TextareaProps) {
  const autoId = useId();
  const areaId = id ?? autoId;
  const describedBy = error ? `${areaId}-error` : helperText ? `${areaId}-help` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={areaId} className="text-label-md text-on-surface-variant font-medium">
          {label}
        </label>
      ) : null}
      <textarea
        id={areaId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`w-full rounded-md bg-surface-container-lowest text-body-md text-on-surface placeholder:text-outline border px-3 py-3 resize-y transition-colors focus:outline-none focus:ring-2 ${
          error
            ? "border-error focus:border-error focus:ring-error/30"
            : "border-outline-variant focus:border-primary focus:ring-primary/30"
        } ${className}`}
        {...props}
      />
      {error ? (
        <p id={`${areaId}-error`} className="text-label-sm text-error font-medium">
          {error}
        </p>
      ) : helperText ? (
        <p id={`${areaId}-help`} className="text-label-sm text-on-surface-variant">
          {helperText}
        </p>
      ) : null}
    </div>
  );
}

export default Textarea;
