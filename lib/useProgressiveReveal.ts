"use client";

import { useEffect, useState, type RefObject } from "react";

export interface UseProgressiveRevealOptions {
  step?: number;
  /**
   * True for a vertical list (rootMargin extends downward, in the scroll
   * direction) -- false (default) for the horizontal carousels this hook was
   * originally built for (rootMargin extends rightward). Getting this wrong
   * means the sentinel's intersection margin sits perpendicular to the
   * actual scroll axis, so it may never fire before the user reaches it.
   */
  vertical?: boolean;
}

/**
 * Reveals `total` items `step` at a time, growing as the trailing sentinel
 * scrolls into view of the `rootRef` container -- an infinite-scroll-style
 * "load gradually" for carousels and lists, so a large list (e.g. a
 * country-wide destination's places/reels, or a 100-item events fetch)
 * doesn't mount hundreds of <img> tags at once.
 *
 * `rootRef`/`sentinelRef` are created by the caller (`useRef` in the
 * component) rather than by this hook -- attach `rootRef` to the scrolling
 * container (the `overflow-x-auto`/`overflow-y-auto` div) and `sentinelRef`
 * to a trailing 1px element after the last rendered card. Pass `null` for
 * `rootRef` when the *viewport itself* is the scroll container (e.g. a
 * vertical page list with no inner scrolling div) -- passing a ref to a
 * non-scrolling element as `root` means IntersectionObserver never fires,
 * since that element never actually scrolls.
 */
export function useProgressiveReveal(
  total: number,
  rootRef: RefObject<HTMLDivElement | null> | null,
  sentinelRef: RefObject<HTMLDivElement | null>,
  options: UseProgressiveRevealOptions = {}
): number {
  const { step = 8, vertical = false } = options;
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
    const rootMargin = vertical ? "0px 0px 200px 0px" : "0px 200px 0px 0px";
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((count) => Math.min(count + step, total));
        }
      },
      { root: rootRef?.current ?? null, rootMargin, threshold: 0 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [total, step, vertical, rootRef, sentinelRef]);

  return Math.min(visibleCount, total);
}
