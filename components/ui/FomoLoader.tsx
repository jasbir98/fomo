"use client";

import { useEffect, useState } from "react";

export interface FomoLoaderProps {
  /** Applied to the outer wrapper — callers own layout (full-page centering, a min-height, etc.), this component only owns the mascot+caption. */
  className?: string;
  /** Rotating caption strings, swapped every ~2.2s. Defaults to a small stock set below. Pass a single-item array (or `[]`) for a static/no caption. */
  captions?: string[];
}

const DEFAULT_CAPTIONS = [
  "Finding the good stuff…",
  "Checking prices…",
  "Asking around Edinburgh…",
];

/**
 * The Fomo mascot (public/brand/fomo-instagram-mascot.svg), gently
 * bobbing/squashing (app/globals.css's `.fomo-loader-bounce`, respects
 * `prefers-reduced-motion`) with a small rotating caption underneath —
 * replaces the bare `<Icon name="auto_awesome" className="animate-pulse" />`
 * full-page loading block that used to be copy-pasted across every detail
 * page (happening/event/place/social/experience).
 *
 * Inlined rather than `<img src=".../fomo-instagram-mascot.svg">` so the
 * navy square background the source file paints for its Instagram-post
 * canvas (a `<rect>` covering the full viewBox) can be dropped — this
 * renders just the mascot mark on whatever background it's placed over.
 *
 * For a full-page state, not a tiny inline spinner (a button's own pending
 * state, a small "refreshing" affordance) — those stay as they were.
 */
export function FomoLoader({ className = "", captions = DEFAULT_CAPTIONS }: FomoLoaderProps) {
  const [captionIndex, setCaptionIndex] = useState(0);

  useEffect(() => {
    if (captions.length <= 1) return;
    const timer = setInterval(() => {
      setCaptionIndex((i) => (i + 1) % captions.length);
    }, 2200);
    return () => clearInterval(timer);
  }, [captions]);

  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 ${className}`}
      role="status"
      aria-live="polite"
    >
      <svg
        viewBox="-88.9 -88.9 177.8 177.8"
        width={72}
        height={72}
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="fomo-loader-bounce"
      >
        <path d="M0 -48C29 -48 48 -27 48 0C48 29 27 46 0 46C-27 46 -48 29 -48 0C-48 -27 -29 -48 0 -48Z" fill="#fc8a40" />
        <path d="M-42 16C-32 38 -8 45 10 42C-12 36 -32 28 -42 16Z" fill="#e8702a" opacity="0.55" />
        <ellipse cx="-20" cy="-29" rx="12" ry="6" fill="#fff" opacity="0.4" transform="rotate(-35 -20 -29)" />
        <ellipse cx="-16" cy="-6" rx="11" ry="13" fill="#fff" />
        <ellipse cx="16" cy="-6" rx="11" ry="13" fill="#fff" />
        <circle cx="-14" cy="-3" r="5.5" fill="#1b365d" />
        <circle cx="18" cy="-3" r="5.5" fill="#1b365d" />
        <circle cx="-12" cy="-5" r="1.8" fill="#fff" />
        <circle cx="20" cy="-5" r="1.8" fill="#fff" />
        <ellipse cx="-33" cy="12" rx="7" ry="4" fill="#ff5a5a" opacity="0.3" />
        <ellipse cx="33" cy="12" rx="7" ry="4" fill="#ff5a5a" opacity="0.3" />
        <path d="M-13 13Q0 32 13 13Z" fill="#1b365d" />
        <path d="M-6 19Q0 14 6 19Q0 24 -6 19Z" fill="#ff7a8a" />
      </svg>
      {captions.length > 0 ? (
        <span className="text-label-md font-semibold text-on-surface-variant">{captions[captionIndex]}</span>
      ) : null}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export default FomoLoader;
