"use client";

import { useEffect, useRef, useState } from "react";
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
 * 2+ segment toggle. Active segment = navy/white pill sliding across a
 * surface-container track (measured against the active button's own
 * position/width via refs, so it works for any number/width of options —
 * not just an even 3-way split). Used for Timeline⇄Calendar, Voice⇄Photo,
 * and Home's Now/This month/Coming up window control.
 */
export function SegmentedControl<T extends string = string>({
  value,
  options,
  onChange,
  className = "",
}: SegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Map<T, HTMLButtonElement>>(new Map());
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  useEffect(() => {
    function measure() {
      const track = trackRef.current;
      const btn = buttonRefs.current.get(value);
      if (!track || !btn) return;
      const trackRect = track.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      setIndicator({ left: btnRect.left - trackRect.left, width: btnRect.width });
    }
    // Measure synchronously after paint so the indicator never flashes at
    // its previous position, then re-measure on resize (orientation change,
    // font load reflow) since the pill's box is computed in pixels, not %.
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [value, options.length]);

  return (
    <div
      ref={trackRef}
      role="tablist"
      className={`relative inline-flex items-center gap-1 rounded-full bg-surface-container p-1 ${className}`}
    >
      {/* Sliding active-segment indicator — sits behind the buttons and
          animates via left/width transitions so switching segments reads as
          motion, not an instant colour swap. Skipped on first paint (no
          `indicator` yet) rather than defaulting to segment 0, and disabled
          under prefers-reduced-motion (the selection still moves, it just
          doesn't glide). */}
      {indicator ? (
        <div
          aria-hidden="true"
          className="absolute inset-y-1 left-0 rounded-full bg-primary shadow-sm transition-[left,width] duration-300 ease-out motion-reduce:transition-none"
          style={{ left: indicator.left, width: indicator.width }}
        />
      ) : null}
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              if (el) buttonRefs.current.set(opt.value, el);
              else buttonRefs.current.delete(opt.value);
            }}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={`relative z-10 inline-flex items-center justify-center gap-1.5 rounded-full px-4 min-h-[40px] text-label-md font-medium transition-colors duration-200 flex-1 whitespace-nowrap ${
              active ? "text-on-primary" : "bg-transparent text-on-surface-variant hover:text-on-surface"
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
