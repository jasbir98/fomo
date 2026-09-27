"use client";

import { useRouter } from "next/navigation";
import type { KeyboardEvent, ReactNode } from "react";

export type NavCardProps = {
  href: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  /** Fires on pointerdown/touchstart, before the click that actually
   *  navigates — for a card that wants to kick off `href`'s data fetch a
   *  beat early (see lib/happenings/preview-cache.ts's `prefetchHappening`).
   *  Never blocks navigation; a slow/failed prefetch just means the
   *  destination fetches for itself, same as if this weren't here. */
  onPointerDown?: () => void;
  /** Fires synchronously right before `router.push(href)` — for a card to
   *  hand the destination page something it already knows (e.g. writing a
   *  preview into lib/happenings/preview-cache.ts) so the destination can
   *  paint instantly instead of starting blank. */
  onNavigate?: () => void;
};

/**
 * Makes a whole card tappable to `href` while it still contains its own
 * real interactive elements (a CTA `<a target="_blank">`, a bookmark
 * `<button>`, a "copy code" `<button>`) — the Fomo home feed's cards all
 * need this (Happening hero/list cards, Free Any Time rows), and the naive
 * fix (wrap the card in next/link's `<a>`) is invalid HTML: the HTML spec
 * forbids interactive content nested inside an `<a>`, which is exactly what
 * a bookmark button or a second link inside the card would be.
 *
 * So this is a plain `<div role="link">` instead of `<Link>` — clicking
 * anywhere in the card navigates via `router.push`, but any inner
 * button/anchor that calls `event.stopPropagation()` in its own handler
 * short-circuits that (the click never reaches this div), so "copy code" /
 * "save" / the outbound CTA all keep working without also triggering a
 * navigation. The trade-off: this is not a real `<a>`, so cmd/ctrl-click
 * "open in new tab" and right-click "copy link" don't work on the card body
 * itself — acceptable here since the card's own real links (the CTA) still
 * support those natively.
 */
export function NavCard({ href, children, className = "", ariaLabel, onPointerDown, onNavigate }: NavCardProps) {
  const router = useRouter();

  function handleClick() {
    // A nested interactive element (button/anchor) that wants to own its
    // own click calls `event.stopPropagation()` in its own handler, which
    // stops the click from ever reaching this div's handler at all (React's
    // synthetic event system honors stopPropagation the same way the DOM
    // does) — so by the time this runs, nothing downstream claimed the
    // click, and it's safe to always navigate.
    onNavigate?.();
    router.push(href);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return; // let a focused inner control handle its own keys
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      router.push(href);
    }
  }

  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onPointerDown={onPointerDown}
      className={`${className} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}
    >
      {children}
    </div>
  );
}

export default NavCard;
