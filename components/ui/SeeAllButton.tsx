import Link from "next/link";
import { Icon } from "./Icon";

export interface SeeAllButtonProps {
  href: string;
  /** Total item count, when known — rendered as "See all N". Omit (or pass a
   *  value `<= shown`) for a plain "See all". */
  total?: number | null;
  /** How many are already visible above this button — the button only
   *  renders when `total` exceeds this, same gate every caller already used
   *  for its header "See all" link (e.g. Home's SECTION_CAP). */
  shown: number;
  className?: string;
}

/**
 * Full-width "See all N →" button at the end of a truncated vertical list —
 * the header's own `SectionHeader` `seeAllHref` link is a small pill easy to
 * miss above a 5-card list; this is the same destination, restated as a
 * button you land on right where the list runs out. Tonal, not the header
 * pill's glass treatment, since this sits on the page's own background
 * rather than over a hero image.
 */
export function SeeAllButton({ href, total, shown, className = "" }: SeeAllButtonProps) {
  if (total == null || total <= shown) return null;
  return (
    <Link
      href={href}
      className={`flex h-11 w-full items-center justify-center gap-1 rounded-xl bg-secondary-container px-4 text-label-lg font-semibold text-on-secondary-container transition-opacity hover:opacity-90 ${className}`}
    >
      See all {total}
      <Icon name="chevron_right" size={20} />
    </Link>
  );
}

export default SeeAllButton;
