"use client";

import { useLayoutEffect, useState, type ReactNode } from "react";

export interface StickyFilterBarProps {
  children: ReactNode;
  className?: string;
}

/**
 * Sticks a page's filter row (a FilterSheet trigger + active-filter pills,
 * plus any adjacent action like the /book-early "Ask Fomo" button) to the
 * top of the viewport while the list below it scrolls — shared by /deals,
 * /book-early and /free instead of three copies of the same positioning
 * classes. Deliberately just the button row: keep intro copy above this
 * component so it scrolls away normally.
 *
 * Sticks directly beneath PageHeader (components/ui/PageHeader.tsx), which
 * is itself `sticky top-0` with `pt-safe` + `min-h-[52px]` — on a device
 * with a safe-area inset (a notch/Dynamic Island), pt-safe's padding can
 * push the header taller than 52px, so a hardcoded `top` would either gap
 * under it or, worse, sit underneath it. This measures PageHeader's real
 * rendered height (there's exactly one `<header>` per page in this shell)
 * via ResizeObserver and uses that as `top`, re-measuring on rotation/resize;
 * `calc(env(safe-area-inset-top) + 52px)` — PageHeader's own box-model, just
 * computed statically — is only the SSR/pre-measurement fallback so there's
 * no flash at 0 before the effect runs.
 *
 * Solid `bg-background` (not translucent, no backdrop-blur) — see the Home
 * feed header's own doc comment (app/(shell)/page.tsx) on why a sticky bar
 * needs to actually occlude what scrolls behind it rather than let it show
 * through. `z-30`: below PageHeader's `z-40` (they never overlap, but this
 * keeps the stacking order sane) and BottomSheet's `z-[60]` (so opening the
 * Filters sheet still covers this bar, not the other way round).
 */
export function StickyFilterBar({ children, className = "" }: StickyFilterBarProps) {
  const [headerHeight, setHeaderHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const header = document.querySelector("header");
    if (!header) return;
    const update = () => setHeaderHeight(header.getBoundingClientRect().height);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={`sticky z-30 border-b border-hairline bg-background py-2 ${className}`}
      style={{ top: headerHeight != null ? `${headerHeight}px` : "calc(env(safe-area-inset-top) + 52px)" }}
    >
      {children}
    </div>
  );
}

export default StickyFilterBar;
