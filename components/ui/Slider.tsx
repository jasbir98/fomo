"use client";

import type { ReactNode } from "react";

export type SliderProps = {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** End label at the low (left) end, e.g. "Luxury". */
  leftLabel?: ReactNode;
  /** End label at the high (right) end, e.g. "Backpacker". */
  rightLabel?: ReactNode;
  className?: string;
  "aria-label"?: string;
};

/**
 * Range slider with a navy thumb + filled track (accent-primary) and optional
 * bipolar end labels. Controlled via value / onChange.
 */
export function Slider({
  value,
  onChange,
  min = 1,
  max = 5,
  step = 1,
  leftLabel,
  rightLabel,
  className = "",
  ...aria
}: SliderProps) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {(leftLabel || rightLabel) && (
        <div className="flex justify-between items-center text-label-md text-on-surface-variant font-medium">
          <span>{leftLabel}</span>
          <span>{rightLabel}</span>
        </div>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={aria["aria-label"]}
        aria-valuetext={String(value)}
        className="w-full h-6 cursor-pointer accent-primary bg-transparent"
      />
    </div>
  );
}

export default Slider;
