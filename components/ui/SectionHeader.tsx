import Link from "next/link";
import { Icon } from "./Icon";

export interface SectionHeaderProps {
  title: string;
  /** Subtitle / one-line reason under the title (e.g. "Enough time, all within 15 min"). */
  meta?: string | null;
  /** When present, renders a "See all" link to this href. */
  seeAllHref?: string | null;
  className?: string;
}

/**
 * Shared section header for a titled content shelf: title, an optional
 * meta/reason line beneath it, and an optional "See all →" link. Nothing
 * like this existed anywhere in the app before — every section heading
 * (Home's rail, the old dashboard) hand-rolled its own `<h3>`/meta markup
 * with no way to link out, which is the root cause behind "no way to see
 * more" (plan-v1-home-pivot.md W1). Typography matches the rail header
 * already in app/(shell)/page.tsx so this drops in without a visual seam.
 */
export function SectionHeader({ title, meta, seeAllHref, className = "" }: SectionHeaderProps) {
  return (
    <div className={`mb-3 flex items-start justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <h3 className="text-label-md font-bold text-primary">{title}</h3>
        {meta ? <p className="mt-0.5 truncate text-label-sm text-on-surface-variant">{meta}</p> : null}
      </div>
      {seeAllHref ? (
        <Link
          href={seeAllHref}
          className="flex shrink-0 items-center gap-0.5 text-label-sm font-semibold text-primary transition-opacity hover:opacity-80"
        >
          See all
          <Icon name="chevron_right" size={16} />
        </Link>
      ) : null}
    </div>
  );
}

export default SectionHeader;
