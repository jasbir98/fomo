"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * Reveals `total` items `step` at a time, growing as the trailing sentinel
 * scrolls into view of the `rootRef` container -- an infinite-scroll-style
 * "load gradually" for horizontal carousels, so a large list (e.g. a
 * country-wide destination's places/reels) doesn't mount hundreds of <img>
 * tags at once.
 *
 * `rootRef`/`sentinelRef` are created by the caller (`useRef` in the
 * component) rather than by this hook -- attach `rootRef` to the scrolling
 * container (the `overflow-x-auto` div) and `sentinelRef` to a trailing 1px
 * element after the last rendered card.
 */
export function useProgressiveReveal(
  total: number,
  rootRef: RefObject<HTMLDivElement | null>,
  sentinelRef: RefObject<HTMLDivElement | null>,
  step = 8
): number {
  const [visibleCount, setVisibleCount] = useState(step);

  // New data (destination switch, fresh fetch) -- start over at one batch.
  // Adjusting state during render (rather than in an effect) is the
  // React-recommended way to reset derived state when a prop changes.
  const [prevTotal, setPrevTotal] = useState(total);
  if (total !== prevTotal) {
    setPrevTotal(total);
    setVisibleCount(step);
  }

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((count) => Math.min(count + step, total));
        }
      },
      { root: rootRef.current, rootMargin: "0px 200px 0px 0px", threshold: 0 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [total, step, rootRef, sentinelRef]);

  return Math.min(visibleCount, total);
}
