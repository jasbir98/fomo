export type ProgressBarProps = {
  /** 0–100. */
  value: number;
  /** Fill color: navy (default) or orange. */
  tone?: "navy" | "orange";
  className?: string;
  label?: string;
};

/**
 * Thin progress track for setup completion %.
 */
export function ProgressBar({ value, tone = "navy", className = "", label }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className={`h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high ${className}`}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={`h-full rounded-full transition-all duration-500 ${
          tone === "orange" ? "bg-secondary-container" : "bg-primary"
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default ProgressBar;
