"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import { tryOpenDetail } from "@/lib/detail-overlay/store";

export type NavCardProps = {
  href: string;
  children: ReactNode;
  className?: string;
  /** Fires on pointerdown/touchstart, before the click that actually
   *  navigates — for a card that wants to kick off `href`'s data fetch a
   *  beat early (see lib/happenings/preview-cache.ts's `prefetchHappening`).
   *  Never blocks navigation; a slow/failed prefetch just means the
   *  destination fetches for itself, same as if this weren't here. */
  onPointerDown?: () => void;
  /** Fires synchronously right before navigating — for a card to hand the
   *  destination page something it already knows (e.g. writing a preview
   *  into lib/happenings/preview-cache.ts) so the destination can paint
   *  instantly instead of starting blank. */
  onNavigate?: () => void;
};

type NavCardContextValue = {
  href: string;
  onNavigate?: () => void;
};

const NavCardContext = createContext<NavCardContextValue | null>(null);

/** Interactive elements inside a card that own their own click. */
const INTERACTIVE = "a[href], button, input, select, textarea, label, [role='button']";

/**
 * Makes a whole card tappable to `href` while it still contains its own
 * real interactive elements (a CTA `<a target="_blank">`, a bookmark
 * `<button>`, a "copy code" `<button>`). Wrapping the card in one `<a>` is
 * invalid HTML (the spec forbids interactive content inside an `<a>`), so
 * the card's real link is its title instead: render the title through
 * `<NavCardLink>`, which is a next/link `<Link href>`. That gives the server
 * HTML a crawlable `<a href="/event/…">` with the title as its anchor text,
 * keyboard focus, and cmd-click / "copy link" on the title.
 *
 * A click anywhere else on the card is forwarded to that title link, so the
 * whole card still navigates through exactly one path: the link's own
 * onClick (`onNavigate`), then DetailOverlayProvider's capture-phase
 * listener (desktop overlay) or next/link (phones). Inner buttons/anchors
 * keep their own clicks: they either `stopPropagation()` or are skipped by
 * the `INTERACTIVE` check below.
 */
export function NavCard({ href, children, className = "", onPointerDown, onNavigate }: NavCardProps) {
  const router = useRouter();

  // Pointer-hover prefetch, for desktop: the cursor is on a card a beat before
  // the click, the same head start `onPointerDown` gives a touch. A no-op on
  // touch (no hover), and Next dedupes repeat prefetches of the same href.
  function handleMouseEnter() {
    router.prefetch(href);
  }

  function handleClick(e: MouseEvent<HTMLDivElement>) {
    const hit = e.target instanceof Element ? e.target.closest(INTERACTIVE) : null;
    if (hit && e.currentTarget.contains(hit)) return; // the title link or an inner control handles its own click
    const link = e.currentTarget.querySelector<HTMLAnchorElement>("a[data-navcard-link]");
    if (e.metaKey || e.ctrlKey) {
      window.open(link?.href ?? href, "_blank", "noopener");
      return;
    }
    if (link) {
      link.click();
      return;
    }
    // No <NavCardLink> rendered: navigate directly.
    onNavigate?.();
    if (!tryOpenDetail(href)) router.push(href);
  }

  return (
    <NavCardContext.Provider value={{ href, onNavigate }}>
      <div
        onClick={handleClick}
        onPointerDown={onPointerDown}
        onMouseEnter={handleMouseEnter}
        className={`${className} has-[[data-navcard-link]:focus-visible]:outline has-[[data-navcard-link]:focus-visible]:outline-2 has-[[data-navcard-link]:focus-visible]:outline-offset-2 has-[[data-navcard-link]:focus-visible]:outline-primary`}
      >
        {children}
      </div>
    </NavCardContext.Provider>
  );
}

/**
 * The card's title as its real link (see NavCard). Renders plain children
 * outside a NavCard, so a summary component shared with a non-link card
 * variant can use it unconditionally.
 */
export function NavCardLink({ children }: { children: ReactNode }) {
  const ctx = useContext(NavCardContext);
  if (!ctx) return <>{children}</>;
  return (
    <Link
      href={ctx.href}
      // Prefetch on hover/pointerdown (NavCard) rather than for every card
      // that scrolls into view.
      prefetch={false}
      onClick={() => ctx.onNavigate?.()}
      data-navcard-link=""
      className="focus-visible:outline-none"
    >
      {children}
    </Link>
  );
}

export default NavCard;
