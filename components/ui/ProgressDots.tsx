export type ProgressDotsProps = {
  count: number;
  /** Zero-based active index. */
  active: number;
  /** Active dot color: navy (default) or orange. */
  tone?: "navy" | "orange";
  className?: string;
};

/**
 * Carousel position indicator. Active dot is elongated + tinted.
 */
export function ProgressDots({ count, active, tone = "navy", className = "" }: ProgressDotsProps) {
  return (
    <div className={`flex items-center justify-center gap-2 ${className}`} role="tablist">
      {Array.from({ length: count }).map((_, i) => {
        const on = i === active;
        return (
          <span
            key={i}
            role="tab"
            aria-selected={on}
            className={`h-2 rounded-full transition-all duration-300 ${
              on
                ? `w-6 ${tone === "orange" ? "bg-secondary-container" : "bg-primary"}`
                : "w-2 bg-outline-variant"
            }`}
          />
        );
      })}
    </div>
  );
}

export default ProgressDots;
