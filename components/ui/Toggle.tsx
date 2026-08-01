"use client";

import type { ReactNode } from "react";

export type ToggleProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
};

/**
 * Switch. Navy track when on. Controlled via checked / onChange.
 * Renders an optional inline label (click toggles).
 */
export function Toggle({ checked, onChange, label, disabled, id, className = "" }: ToggleProps) {
  return (
    <label
      htmlFor={id}
      className={`inline-flex items-center gap-3 ${disabled ? "opacity-40" : "cursor-pointer"} ${className}`}
    >
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
          checked ? "bg-primary" : "bg-surface-variant"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-surface-container-lowest shadow transition-transform ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
      {label ? <span className="text-body-md text-on-surface">{label}</span> : null}
    </label>
  );
}

export default Toggle;
