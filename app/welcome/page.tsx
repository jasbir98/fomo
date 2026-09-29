"use client";

import { Suspense, useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, FomoLogo, ProgressDots } from "@/components/ui";
import { BookEarlyScene, DealsScene, WhatsOnScene } from "@/components/onboarding/Characters";
import { safeNext } from "@/lib/auth/safe-next";
import { publicNextOrHome } from "@/lib/auth/public-next";
import { NOTIFY_ME_ENABLED } from "@/lib/happenings/book-early";

/** Hand-drawn orange underline for the word each headline hangs on. */
function Scribble({ children }: { children: ReactNode }) {
  return (
    <span className="relative inline-block">
      <span className="relative z-10">{children}</span>
      <svg
        viewBox="0 0 120 12"
        preserveAspectRatio="none"
        className="absolute -bottom-1 left-0 h-2.5 w-full"
        aria-hidden="true"
      >
        <path
          d="M2 8C30 2 60 11 118 4"
          stroke="#fc8a40"
          strokeWidth={4}
          fill="none"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </span>
  );
}

type Slide = {
  scene: ReactNode;
  /** Page background while this slide is showing — cross-fades between slides. */
  tint: string;
  title: ReactNode;
  body: ReactNode;
};

/**
 * Slide 3's body promises push notifications — only true when web push is
 * actually wired up (NEXT_PUBLIC_VAPID_PUBLIC_KEY set; see
 * lib/happenings/book-early.ts's NOTIFY_ME_ENABLED, which every "Notify me"
 * control in the app already gates on). Falls back to copy about Saved,
 * which is true regardless.
 */
const BOOK_EARLY_BODY = NOTIFY_ME_ENABLED ? (
  <>
    Get a ping when tickets go live,
    <br />
    and ask Fomo for ideas.
  </>
) : (
  <>
    Save the good stuff. It&rsquo;s all
    <br />
    in one place when you need it.
  </>
);

const SLIDES: Slide[] = [
  {
    scene: <WhatsOnScene />,
    tint: "#fff1e3",
    title: (
      <>
        Never miss <Scribble>what&rsquo;s on</Scribble>
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
    scene: <DealsScene />,
    tint: "#e6f5ec",
    title: (
      <>
        <Scribble>Free</Scribble>, cheap
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
    scene: <BookEarlyScene />,
    tint: "#ecebff",
    title: (
      <>
        Book before
        <br />
        it <Scribble>sells out</Scribble>
      </>
    ),
    body: BOOK_EARLY_BODY,
  },
];

const SWIPE_THRESHOLD = 40;
const SEEN_INTRO_KEY = "fomo_seen_intro";

// Detail-page route prefixes that a shared link (/happening/<id>, /event/<id>,
// etc.) can point `next` at — used only to decide whether to show the "Sign
// in to see what was shared with you" hint below. Checked against the
// already-`safeNext`-sanitized value, so this never sees an off-origin URL.
const DETAIL_PAGE_PREFIXES = ["/happening/", "/event/", "/place/"];

function isSharedDetailLink(next: string): boolean {
  return DETAIL_PAGE_PREFIXES.some((prefix) => next.startsWith(prefix));
}

function WelcomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [index, setIndex] = useState(0);
  const [dragX, setDragX] = useState(0);
  const touchStartX = useRef<number | null>(null);
  const isLast = index === SLIDES.length - 1;
  const next = safeNext(searchParams.get("next"));
  const sharedLink = next !== "/" && isSharedDetailLink(next);

  function signinHref() {
    return next !== "/" ? `/signin?next=${encodeURIComponent(next)}` : "/signin";
  }

  // "Not now" — a dead end otherwise (no browser back inside the installed
  // iOS PWA): drops straight back to browsing instead of funnelling through
  // sign-in like Skip/"Get started" do. Back to whatever `next` was pointing
  // at if a signed-out visitor can actually see it, else Home.
  function markIntroSeen() {
    try {
      window.localStorage.setItem(SEEN_INTRO_KEY, "1");
    } catch {
      // ignore — see `finish()`'s identical try/catch above.
    }
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

  // The track follows the finger; past either end it drags at a third of the
  // distance so the edge feels elastic rather than broken.
  function onTouchMove(e: TouchEvent<HTMLDivElement>) {
    if (touchStartX.current == null) return;
    const dx = (e.touches[0]?.clientX ?? 0) - touchStartX.current;
    const atEdge = (index === 0 && dx > 0) || (isLast && dx < 0);
    setDragX(atEdge ? dx / 3 : dx);
  }

  function onTouchEnd(e: TouchEvent<HTMLDivElement>) {
    if (touchStartX.current == null) return;
    const delta = (e.changedTouches[0]?.clientX ?? 0) - touchStartX.current;
    touchStartX.current = null;
    setDragX(0);
    if (delta <= -SWIPE_THRESHOLD) goNext();
    else if (delta >= SWIPE_THRESHOLD) goPrev();
  }

  function onTouchCancel() {
    touchStartX.current = null;
    setDragX(0);
  }

  const dragging = dragX !== 0;

  return (
    <div
      className="flex min-h-dvh w-full flex-col overflow-hidden pt-safe pb-safe transition-colors duration-500"
      style={{ backgroundColor: SLIDES[index].tint }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      {/* Brand lockup + persistent Skip */}
      <div className="flex items-center justify-between px-6 pt-10 pb-4">
        <div className="w-12" aria-hidden="true" />
        <div className="flex items-center justify-center gap-2">
          <FomoLogo tone="light" size={30} />
        </div>
        <button
          type="button"
          onClick={finish}
          className="w-12 text-right text-label-md font-medium text-on-surface-variant"
        >
          Skip
        </button>
      </div>

      {/* Slide track */}
      <div className="flex flex-1 flex-col justify-center overflow-hidden">
        <div
          className="flex"
          style={{
            transform: `translateX(calc(${-index * 100}% + ${dragX}px))`,
            transition: dragging ? "none" : "transform 480ms cubic-bezier(0.22, 0.8, 0.2, 1)",
          }}
        >
          {SLIDES.map((s, i) => (
            <section
              key={i}
              aria-hidden={i !== index}
              className={`flex w-full shrink-0 flex-col items-center px-6 transition-[opacity,scale] duration-500 ${
                i === index ? "scale-100 opacity-100" : "scale-90 opacity-0"
              }`}
            >
              <div className="mb-4 h-[min(50dvh,400px)] w-full max-w-[420px]">{s.scene}</div>
              <h1 className="mb-3 text-center text-headline-md text-on-surface">{s.title}</h1>
              <p className="mx-auto max-w-[280px] text-center text-body-md text-on-surface-variant">
                {s.body}
              </p>
            </section>
          ))}
        </div>
      </div>

      {/* Bottom controls */}
      <div className="flex flex-col items-center gap-6 px-6 pt-6 pb-6">
        <ProgressDots count={SLIDES.length} active={index} tone="orange" />
        {sharedLink && (
          <p className="text-body-md text-on-surface-variant">
            Sign in to see what was shared with you
          </p>
        )}
        <Button variant="orange" fullWidth size="md" onClick={goNext}>
          {isLast ? "Get started" : "Next"}
        </Button>
        <Link
          href={publicNextOrHome(searchParams.get("next"))}
          onClick={markIntroSeen}
          className="-mt-3 inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-outline-variant text-label-lg font-semibold text-primary transition-colors hover:bg-surface-container-low active:bg-surface-container"
        >
          Not now, keep browsing
        </Link>
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
