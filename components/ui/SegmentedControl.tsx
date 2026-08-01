"use client";

import { Icon } from "./Icon";

export type SegmentOption<T extends string = string> = {
  value: T;
  label: string;
  /** Optional Material Symbols name shown before the label. */
  icon?: string;
};

export type SegmentedControlProps<T extends string = string> = {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  className?: string;
};

/**
 * 2+ segment toggle. Active segment = navy/white pill on a surface-container
 * track. Used for Timeline⇄Calendar and Voice⇄Photo.
 */
export function SegmentedControl<T extends string = string>({
  value,
  options,
  onChange,
  className = "",
}: SegmentedControlProps<T>) {
  return (
    <div
      role="tablist"
      className={`inline-flex items-center gap-1 rounded-full bg-surface-container p-1 ${className}`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={`inline-flex items-center justify-center gap-1.5 rounded-full px-4 min-h-[40px] text-label-md font-medium transition-colors flex-1 whitespace-nowrap ${
              active
                ? "bg-primary text-on-primary shadow-sm"
                : "bg-transparent text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {opt.icon ? <Icon name={opt.icon} size={18} filled={active} /> : null}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
