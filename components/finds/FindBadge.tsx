import { Icon } from "@/components/ui/Icon";

/**
 * The small gradient "Picked for you" pill that marks anything on one of the
 * hand-picked weekly lists (in-app "For you"; the same picks go out as the
 * @askfomo "Fomo Finds" Instagram series) wherever it appears elsewhere:
 * feed rows, Book early, Deals, the detail pages. Callers decide whether to
 * show it with `useFind(type, id)` (lib/finds/useFinds.ts); the pill itself is
 * presentational. It is deliberately not rendered on FindCard, which is
 * already the picks list.
 *
 * Contrast: white text uses the deepened `bg-find-gradient-ink` stops
 * (#C2410C -> #BE185D -> #6D28D9, 5.2 / 6.0 / 7.1:1 against white, AA at this
 * small size). The exact IG colours (#FF8A3D / #FF3D7F / #8B5CF6) only give
 * white text 2.35 / 3.37 / 4.23:1, so they are kept for the non-text Fomo level
 * pips and the OG image. See the tokens in app/globals.css.
 *
 * With `why`, renders the pill plus the one-line "why it's a steal" beneath it,
 * for the detail pages.
 */
export interface FindBadgeProps {
  /** The pick's "why it's a steal" line; shown under the pill when given. */
  why?: string | null;
  className?: string;
}

export function FindBadge({ why, className = "" }: FindBadgeProps) {
  const pill = (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-find-gradient-ink px-2 py-0.5 text-label-sm font-bold uppercase leading-none tracking-wide text-white">
      <Icon name="auto_awesome" filled size={12} className="shrink-0" />
      Picked for you
    </span>
  );
  if (!why) return <span className={`inline-flex ${className}`}>{pill}</span>;
  return (
    <div className={`flex flex-col items-start gap-1.5 ${className}`}>
      {pill}
      <p className="text-body-md font-semibold text-on-surface">{why}</p>
    </div>
  );
}

export default FindBadge;
