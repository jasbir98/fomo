"use client";

import { Suspense, useEffect, useRef, useState, type TouchEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, ProgressDots } from "@/components/ui";
import { safeNext } from "@/lib/auth/safe-next";

// Hero treatments for the Fomo Edinburgh intro (replaces the pre-pivot travel
// illustrations reused from `Fomo copy/app/onboarding/page.tsx`). Simple,
// on-brand Material Symbols in soft tinted circles rather than redrawn scene
// art — deliberately plain so there's no travel-specific imagery to update
// again on the next pivot.
function heroIcon(icon: string, tint: string, accent: string): string {
  return `<svg viewBox="0 0 200 158" width="100%" height="100%">
    <circle cx="20" cy="20" r="2.5" fill="${accent}" opacity="0.3"></circle>
    <circle cx="180" cy="30" r="3" fill="${accent}" opacity="0.3"></circle>
    <circle cx="178" cy="135" r="2.5" fill="${accent}" opacity="0.4"></circle>
    <circle cx="22" cy="130" r="2" fill="${accent}" opacity="0.5"></circle>
    <circle cx="100" cy="79" r="48" fill="${tint}"></circle>
    <text x="100" y="79" text-anchor="middle" dominant-baseline="central"
      font-family="'Material Symbols Outlined'" font-size="56" fill="${accent}">${icon}</text>
  </svg>`;
}

const HERO_WHATS_ON = heroIcon("celebration", "#FDE8D8", "#C04A2B");
const HERO_DEALS = heroIcon("sell", "#E1EAF7", "#1B365D");
const HERO_BOOK_EARLY = heroIcon("confirmation_number", "#E4EEE0", "#5C7A52");

type Slide = {
  hero: string;
  title: React.ReactNode;
  body: React.ReactNode;
};

const SLIDES: Slide[] = [
  {
    hero: HERO_WHATS_ON,
    title: (
      <>
        Never miss what&rsquo;s on
        <br />
        in Edinburgh
      </>
    ),
    body: (
      <>
        Events, festivals and things
        <br />
        happening this week.
      </>
    ),
  },
  {
    hero: HERO_DEALS,
    title: (
      <>
        Free, cheap
        <br />
        &amp; discounted
      </>
    ),
    body: (
      <>
        Deals for students, EH residents,
        <br />
        under-26s and over-60s.
      </>
    ),
  },
  {
    hero: HERO_BOOK_EARLY,
    title: (
      <>
        Book before
        <br />
        it sells out
      </>
    ),
    body: (
      <>
        Get told when tickets go live —
        <br />
        plus Ask Fomo for ideas.
      </>
    ),
  },
];

const SWIPE_THRESHOLD = 40;
const SEEN_INTRO_KEY = "fomo_seen_intro";

// Detail-page route prefixes that a shared link (/happening/<id>, /event/<id>,
// etc.) can point `next` at — used only to decide whether to show the "Sign
// in to see what was shared with you" hint below. Checked against the
// already-`safeNext`-sanitized value, so this never sees an off-origin URL.
const DETAIL_PAGE_PREFIXES = ["/happening/", "/event/", "/experience/", "/place/", "/social/"];

function isSharedDetailLink(next: string): boolean {
  return DETAIL_PAGE_PREFIXES.some((prefix) => next.startsWith(prefix));
}

function WelcomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [index, setIndex] = useState(0);
  const touchStartX = useRef<number | null>(null);
  const isLast = index === SLIDES.length - 1;
  const slide = SLIDES[index];
  const next = safeNext(searchParams.get("next"));
  const sharedLink = next !== "/" && isSharedDetailLink(next);

  function signinHref() {
    return next !== "/" ? `/signin?next=${encodeURIComponent(next)}` : "/signin";
  }

  function finish() {
    try {
      window.localStorage.setItem(SEEN_INTRO_KEY, "1");
    } catch {
      // localStorage unavailable (private mode) — just move on, we'll show
      // the slides again next time, which is harmless.
    }
    router.push(signinHref());
  }

  // Already seen the slides on this device — skip straight to /signin.
  // This only fires client-side after hydration (localStorage isn't
  // available during SSR), so there's a one-frame flash of slide 1 on
  // repeat visits rather than a hydration mismatch.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(SEEN_INTRO_KEY) === "1") {
        router.replace(signinHref());
      }
    } catch {
      // ignore — fall through and show the slides.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function goNext() {
    if (isLast) {
      finish();
    } else {
      setIndex((i) => Math.min(i + 1, SLIDES.length - 1));
    }
  }

  function goPrev() {
    setIndex((i) => Math.max(i - 1, 0));
  }

  function onTouchStart(e: TouchEvent<HTMLDivElement>) {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  }

  function onTouchEnd(e: TouchEvent<HTMLDivElement>) {
    if (touchStartX.current == null) return;
    const delta = (e.changedTouches[0]?.clientX ?? 0) - touchStartX.current;
    if (delta <= -SWIPE_THRESHOLD) goNext();
    else if (delta >= SWIPE_THRESHOLD) goPrev();
    touchStartX.current = null;
  }

  return (
    <div
      className="flex min-h-dvh w-full flex-col bg-background px-6 pt-safe pb-safe"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Brand lockup + persistent Skip */}
      <div className="flex items-center justify-between pt-10 pb-8">
        <div className="w-12" aria-hidden="true" />
        <div className="flex items-center justify-center gap-2">
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="10" className="fill-primary" />
            <path
              d="M0 10C0 15.5228 4.47715 20 10 20C15.5228 20 20 15.5228 20 10H0Z"
              className="fill-secondary-container"
            />
          </svg>
          <span className="text-headline-sm text-on-surface">
            Fomo<span className="text-secondary-container">.</span>
          </span>
        </div>
        <button
          type="button"
          onClick={finish}
          className="w-12 text-right text-label-md font-medium text-on-surface-variant"
        >
          Skip
        </button>
      </div>

      {/* Slide content */}
      <div className="flex flex-1 flex-col items-center justify-center">
        <div
          key={index}
          className="mb-8 h-64 w-full max-w-sm shrink-0"
          dangerouslySetInnerHTML={{ __html: slide.hero }}
        />
        <div className="w-full text-center">
          <h1 className="mb-3 text-headline-md text-on-surface">{slide.title}</h1>
          <p className="mx-auto max-w-[280px] text-body-md text-on-surface-variant">
            {slide.body}
          </p>
        </div>
      </div>

      {/* Bottom controls */}
      <div className="flex flex-col items-center gap-8 pt-8 pb-6">
        <ProgressDots count={SLIDES.length} active={index} tone="orange" />
        {sharedLink && (
          <p className="text-body-md text-on-surface-variant">
            Sign in to see what was shared with you
          </p>
        )}
        <Button variant="orange" fullWidth size="md" onClick={goNext}>
          {isLast ? "Get started" : "Next"}
        </Button>
      </div>
    </div>
  );
}

export default function WelcomePage() {
  return (
    <Suspense fallback={null}>
      <WelcomeContent />
    </Suspense>
  );
}
