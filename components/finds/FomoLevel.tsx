/**
 * The 1-5 "Fomo level" meter from the @askfomo "Fomo Finds" Instagram slides,
 * reused on the in-app "For you" cards: five pips, the first `level` filled
 * with the orange -> pink -> purple gradient, the rest muted.
 *
 * The gradient runs across the whole meter (pip 1 orange, pip 3 pink, pip 5
 * purple), not restarting per pip, so a level-5 reads as the full gradient
 * and a level-2 as the warm end of it. Each pip's colour is one `color-mix`
 * between the neighbouring `--color-find-*` stops (app/globals.css), so the
 * tokens stay the single source of the brand colours.
 *
 * Accessibility: the meter is one `role="img"` named "Fomo level 4 of 5"; the
 * pips and the visible caption are hidden from assistive tech so it isn't
 * read twice. Contrast: the pips are a graphic that duplicates the
 * accessible label, and the lightest stop (#FF8A3D) is only 2.35:1 on white,
 * under the 3:1 non-text guideline; the muted pips beside it and the text
 * label carry the meaning, so it isn't colour-only, but flag if a stricter
 * reading is wanted.
 */
export interface FomoLevelProps {
  /** 1-5; clamped and rounded. */
  level: number;
  /** Show the small "Fomo level" caption before the pips. Default true. */
  caption?: boolean;
  className?: string;
}

const PIPS = [0, 1, 2, 3, 4] as const;

/** Colour of pip `i` (0-4) along the from -> via -> to gradient. */
function pipColor(i: number): string {
  const t = i / (PIPS.length - 1);
  return t <= 0.5
    ? `color-mix(in srgb, var(--color-find-from) ${Math.round((1 - t * 2) * 100)}%, var(--color-find-via))`
    : `color-mix(in srgb, var(--color-find-via) ${Math.round((1 - (t - 0.5) * 2) * 100)}%, var(--color-find-to))`;
}

export function FomoLevel({ level, caption = true, className = "" }: FomoLevelProps) {
  const filled = Math.max(1, Math.min(5, Math.round(level)));
  return (
    <div role="img" aria-label={`Fomo level ${filled} of 5`} className={`flex items-center gap-2 ${className}`}>
      {caption ? (
        <span aria-hidden="true" className="text-label-sm font-bold uppercase tracking-wide text-on-surface-variant">
          Fomo level
        </span>
      ) : null}
      <span aria-hidden="true" className="flex items-center gap-1">
        {PIPS.map((i) => (
          <span
            key={i}
            className={`h-2 w-5 rounded-full ${i < filled ? "" : "bg-outline-variant/60"}`}
            style={i < filled ? { backgroundColor: pipColor(i) } : undefined}
          />
        ))}
      </span>
    </div>
  );
}

export default FomoLevel;
