"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export type ScrollRailProps = {
  children: ReactNode;
  /** Classes for the outer wrapper (the positioning context for the arrows). */
  className?: string;
  /** Classes for the scrolling element itself — gap, padding, `-mx-4 px-4` bleed, etc. */
  scrollerClassName?: string;
  /** Accessible name for the rail; when set the wrapper becomes a labelled region. */
  ariaLabel?: string;
};

/**
 * Horizontal rail of cards: the same flex + overflow-x-auto + hidden-scrollbar
 * scroller the home strips use (see components/happenings/TodaysDealsStrip.tsx),
 * plus prev/next arrow buttons for mouse users, who have no swipe.
 *
 * The arrows only exist for a pointer that can hover on a >=1024px viewport:
 * `[@media(hover:hover)]:lg:flex` over a base `hidden`, so a touch phone, or an
 * iPad in landscape (1024px but no hover), never sees them and keeps swiping.
 * Each click scrolls ~80% of the visible width (smooth, or instant under
 * prefers-reduced-motion), leaving the last partly-visible card as a visual
 * anchor. An arrow is dropped entirely at the start/end of the rail.
 *
 * Start/end state comes from a scroll listener plus a ResizeObserver on the
 * scroller and each of its children (cards loading images change the content
 * width without any scroll), and a MutationObserver so children added later
 * are observed too. ResizeObserver reports once on `observe()`, which is what
 * produces the initial state — no synchronous setState in the effect.
 */
export function ScrollRail({ children, className = "", scrollerClassName = "", ariaLabel }: ScrollRailProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  const update = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // 1px of slack: scrollLeft is fractional on zoomed/hi-dpi displays.
    setCanPrev(el.scrollLeft > 1);
    setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const resizeObserver = new ResizeObserver(update);
    const observeChildren = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(el);
      for (const child of Array.from(el.children)) resizeObserver.observe(child);
    };
    observeChildren();

    const mutationObserver = new MutationObserver(observeChildren);
    mutationObserver.observe(el, { childList: true });
    el.addEventListener("scroll", update, { passive: true });

    return () => {
      el.removeEventListener("scroll", update);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [update]);

  function scrollByPage(direction: 1 | -1) {
    const el = scrollerRef.current;
    if (!el) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: reduceMotion ? "auto" : "smooth" });
  }

  const arrow =
    "absolute top-1/2 z-10 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-surface-container-lowest text-on-surface shadow-level-2 transition-colors hover:bg-surface-container [@media(hover:hover)]:lg:flex";

  return (
    <div
      className={`relative ${className}`}
      {...(ariaLabel ? { role: "region", "aria-label": ariaLabel } : null)}
    >
      <div
        ref={scrollerRef}
        className={`flex overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${scrollerClassName}`}
      >
        {children}
      </div>
      {canPrev ? (
        <button type="button" aria-label="Scroll left" onClick={() => scrollByPage(-1)} className={`${arrow} left-2`}>
          <Icon name="chevron_left" size={24} />
        </button>
      ) : null}
      {canNext ? (
        <button type="button" aria-label="Scroll right" onClick={() => scrollByPage(1)} className={`${arrow} right-2`}>
          <Icon name="chevron_right" size={24} />
        </button>
      ) : null}
    </div>
  );
}

export default ScrollRail;
