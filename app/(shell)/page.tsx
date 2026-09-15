"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { cityBadge, SUPPORTED_CITIES } from "@/lib/city";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { refreshGeolocation, useGeolocation } from "@/lib/geo";
import { useSignedIn } from "@/lib/useSaved";
import { chooseCity, dismissCityPrompt, useSelectedCity } from "@/lib/useSelectedCity";
import { rememberUserLocation, forgetUserLocation } from "@/lib/now/location";
import type { CardKind, NowResponse } from "@/lib/now/types";
import type { FeedCardData, FeedResponse, FeedWindow } from "@/lib/happenings/feed-types";
import { NOTIFY_ME_ENABLED } from "@/lib/happenings/book-early";
import type { WeatherCondition } from "@/lib/weather";
import { WEATHER_THEME } from "@/lib/weatherUi";
import { CityPicker, ErrorState, Icon, SegmentedControl } from "@/components/ui";
import { FomoCard } from "@/components/fomo/Card";
import { FeedHero, FeedListCard, FreeAnyTimeList, BookEarlyCard } from "@/components/happenings";

interface HomeWeather {
  condition: WeatherCondition;
  tempC: number | null;
}

/**
 * Three tabs, not a window plus a bolted-on list. "This month" used to be a
 * tab here, then a range filter chip inside Coming up; both are gone now.
 * Now/Coming up are disjoint by construction server-side (see
 * occurrenceWindowRange in app/api/feed/route.ts). `book_early` is the third
 * tab, added because Book Early competed for attention as a section wedged
 * under Coming up — it's not a date window at all (the route returns an
 * empty `whatsOn` for it), it swaps out What's on entirely for the ranked
 * Book Early list.
 *
 * Neither Now nor Coming up has any per-day/category filtering here anymore
 * — that used to be an in-place "Show all N" expander plus (Coming up only)
 * a sticky date-pill row bolted onto this page. Both moved to their own
 * destination, app/(shell)/whats-on/page.tsx, reached via each list's
 * "See all N" link below — the filters live where the full list does, not
 * wedged into Home.
 */
const WINDOW_OPTIONS: { value: FeedWindow; label: string }[] = [
  { value: "now", label: "Now" },
  { value: "coming_up", label: "Coming up" },
  { value: "book_early", label: "Book early" },
];

/** What's on section header — deliberately its own wording (not the segmented
 *  control's own labels) so the header reads as "what you're looking at" ("Today
 *  & tomorrow") rather than echoing the tab name ("Now") back at the user.
 *  `book_early` still needs an entry (this is a `Record<FeedWindow, string>`),
 *  but What's on is never rendered on that tab — see the section gating below
 *  — so this value is unreachable rather than a real piece of copy. */
const WHATS_ON_WINDOW_LABEL: Record<FeedWindow, string> = {
  now: "Today & tomorrow",
  coming_up: "Coming up",
  book_early: "Book early",
};

// Throws on abort (caller distinguishes that from a real failure) or a
// non-2xx status — unlike the old version, which swallowed every failure to
// `null`, indistinguishable from "genuinely nothing to show". See the
// [coords] effect below and `refreshNow` for how callers turn a thrown error
// into `nowError` state instead of leaving the permanent "Finding something
// worth your while…" fallback on screen.
async function fetchNowResponse(
  coords: { lat: number; lng: number } | null,
  signal?: AbortSignal
): Promise<NowResponse> {
  const params = new URLSearchParams();
  if (coords) {
    params.set("lat", String(coords.lat));
    params.set("lng", String(coords.lng));
  }
  const res = await fetch(`/api/now?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`GET /api/now ${res.status}`);
  return (await res.json()) as NowResponse;
}

/** `window` drives What's on (and, for `book_early`, swaps it out entirely
 *  and swaps the hero for that tab's own pick) — every other section (Deals,
 *  Free any time) is independent of it. The route also accepts `range`/
 *  `price` params (defaulting to "all" for both), but Home no longer has UI
 *  for either — see the removed Range/Price filter chips — so they're never
 *  sent. */
// Same "throw, don't swallow" contract as fetchNowResponse above — a
// non-2xx status (GET /api/feed's catch block now returns 401/500, not a
// silent 200 with empty sections) becomes a thrown error here so the
// window-fetch effect below can set `feedError` instead of leaving What's
// on/Book early stuck on their loading skeleton, or — worse — rendering
// their genuinely-empty copy ("Nothing lined up... try another tab") for
// what's actually a failed request.
async function fetchFeed(window: FeedWindow, signal?: AbortSignal): Promise<FeedResponse> {
  const params = new URLSearchParams({ window });
  const res = await fetch(`/api/feed?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`GET /api/feed ${res.status}`);
  return (await res.json()) as FeedResponse;
}

function bookEarlyCardKey(card: FeedResponse["bookEarly"][number]): string {
  return card.kind === "happening" ? `happening-${card.happening.id}` : `event-${card.event.id}`;
}

/** Every list section shares one cap+link convention: show the first
 *  SECTION_CAP cards, and — only when there's actually more than that to
 *  show — a "See all N" link out to that section's own dedicated page
 *  (What's on → /whats-on, Book early → /book-early), which shows the full
 *  list plus that page's own filters. Replaces the old in-place "Show all N"
 *  expander (task: "it needs to open a new kind of window... rather than
 *  showing them in the same place"), matching the convention
 *  components/happenings/FreeAnyTimeList.tsx already established for Free
 *  any time's own "See all" link to /free. */
const SECTION_CAP = 5;

function SeeAllLink({ href, total }: { href: string; total: number }) {
  if (total <= SECTION_CAP) return null;
  return (
    <Link
      href={href}
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-surface-container-lowest/80 px-2.5 py-1 text-label-sm font-semibold text-primary backdrop-blur-sm transition-opacity hover:opacity-80"
    >
      See all {total}
      <Icon name="chevron_right" size={16} />
    </Link>
  );
}

/**
 * Fomo Home — a clean, tab-driven skim: a hero card → then, depending on the
 * window control, either What's on (Now/Coming up) or the Book early list
 * (its own tab, not a section wedged under Coming up) → Free any time, shown
 * only on Now so it doesn't repeat itself under every tab. Every list here
 * (What's on, Book early) shows only its first SECTION_CAP cards, followed —
 * only when there's more than that — by a "See all N" link out to that
 * section's own dedicated page (/whats-on, /book-early), which owns the full
 * list AND that list's filters (date/category for What's on; timing/category/
 * month for Book early). No filtering of any kind happens on Home itself
 * anymore. Deals & Offers moved out to its own page (app/(shell)/deals/page.tsx)
 * in the Home decluttering pass — user feedback was "the homepage is messy,
 * all blue, too much text", and Deals' own WHAT/WHO filter chips plus a
 * fourth card list were the single biggest chunk of that. Deals lives ONLY in
 * the bottom nav now (components/shell/BottomNav.tsx) — deliberately no
 * pointer card, teaser, or header shortcut to it anywhere on this page, so it
 * reads as a clean, separate destination rather than a Home section in
 * disguise. `deals` is still part of GET /api/feed's response (the Deals page
 * reads the same route) — Home just never touches that field.
 *
 * The merged read lives behind GET /api/feed (app/api/feed/route.ts) — this
 * page is presentation + the one bit of client state the route can't own
 * (the window).
 *
 * HERO: GET /api/feed's `hero` is ordinarily the best recommendation across
 * dated happenings and free/cheap provider events (lib/happenings/hero.ts),
 * rendered via FeedHero with its "why this" reason; null falls back to the
 * pre-existing /api/now hero via FomoCard, so the page is never blank while
 * the happenings pipeline catches up. On the Book early tab this is
 * different — `heroKind === "book_early"` means `hero` is that tab's own top
 * pick instead (HappeningHero's `variant="book_early"`), and `hero: null`
 * there means no hero at all, never the Fomo Pick/FomoCard fallback (a
 * ranked-across-everything or /api/now pick has no business leading a
 * "book this ahead of time" list).
 */
export default function HomePage() {
  const db = supabaseBrowserAuth();
  const [now, setNow] = useState<NowResponse | null>(null);
  // True only after a real /api/now failure (network error or non-2xx) —
  // distinct from "no now data yet" so the hero fallback can tell "still
  // loading / genuinely nothing" apart from "the request failed" instead of
  // showing the same "Finding something worth your while…" text forever.
  const [nowError, setNowError] = useState(false);
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  // Same idea as `nowError`, for GET /api/feed — see the [feedWindow,
  // feedReloadTick] effect below. `feedReloadTick` exists purely so the
  // What's on / Book early ErrorState's Retry button can re-trigger that
  // effect without duplicating its fetch logic.
  const [feedError, setFeedError] = useState(false);
  const [feedReloadTick, setFeedReloadTick] = useState(0);
  const [weather, setWeather] = useState<HomeWeather | null>(null);
  const [feedWindow, setWindow] = useState<FeedWindow>("now");
  // Window-switch feedback (task: "no animation or changes properly when I
  // select This month / Coming up"). `feedLoading` dims the still-visible
  // previous What's on content the instant a segment is tapped;
  // `whatsOnRenderKey` only bumps once the new window's data has actually
  // landed, which remounts the bucket list under a fresh key so the
  // `feed-fade-in` CSS animation (app/globals.css) plays for the arriving
  // content — two distinct signals for "loading" vs. "here's what changed".
  const [feedLoading, setFeedLoading] = useState(false);
  const [whatsOnRenderKey, setWhatsOnRenderKey] = useState(0);
  const whatsOnSectionRef = useRef<HTMLDivElement>(null);
  const prevFeedWindowRef = useRef<FeedWindow>(feedWindow);
  // Book Early "Notify me" state — the caller's full on-sale-alert
  // happening-id set, loaded once so each BookEarlyCard renders correctly
  // subscribed instead of resetting to "Notify me" on every load. Only
  // fetched when the feature is actually on (NEXT_PUBLIC_VAPID_PUBLIC_KEY
  // set) — no reason to hit /api/alerts on every Home load otherwise.
  const [alertHappeningIds, setAlertHappeningIds] = useState<Set<string>>(new Set());
  const { coords, status: geoStatus } = useGeolocation();
  const signedIn = useSignedIn();
  const { city, source: citySource, shouldPrompt: shouldPromptCity } = useSelectedCity();
  const [cityPickerOpen, setCityPickerOpen] = useState(false);

  // Coarse last-known location, for graceful degradation on a later cold open.
  // Not used for this request, which sends the live reading directly.
  // Signed-in only: it writes to the caller's own profile row.
  useEffect(() => {
    if (!signedIn) return;
    if (geoStatus === "granted" && coords) void rememberUserLocation(db, coords.lat, coords.lng);
    else if (geoStatus === "denied") void forgetUserLocation(db);
  }, [db, geoStatus, coords, signedIn]);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const json = await fetchNowResponse(coords, controller.signal);
        if (controller.signal.aborted) return;
        setNow(json);
        setNowError(false);
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        console.error("[home] /api/now fetch failed", err);
        setNowError(true);
      }
    })();
    return () => controller.abort();
  }, [coords]);

  // Switching the window keeps the previous feed on screen
  // (stale-while-revalidate) rather than unmounting it, but it's now dimmed
  // (`feedLoading`) for immediate feedback, and cross-fades in once the new
  // window's data lands (see `whatsOnRenderKey`). Only the very first load,
  // before `feed` has ever been set, shows the plain skeleton below instead.
  useEffect(() => {
    const controller = new AbortController();
    const isWindowSwitch = prevFeedWindowRef.current !== feedWindow;
    prevFeedWindowRef.current = feedWindow;
    (async () => {
      setFeedLoading(true);
      try {
        const json = await fetchFeed(feedWindow, controller.signal);
        if (controller.signal.aborted) return;
        setFeed(json);
        setFeedError(false);
        setFeedLoading(false);
        setWhatsOnRenderKey((k) => k + 1);
        // Make the change unmissable when What's on isn't currently in view —
        // only scrolls when its top is below the fold (never yanks the page
        // for a section already on screen, and never scrolls upward).
        if (isWindowSwitch) {
          requestAnimationFrame(() => {
            const el = whatsOnSectionRef.current;
            if (!el || typeof window === "undefined") return;
            const top = el.getBoundingClientRect().top;
            if (top > window.innerHeight) {
              const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
              el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
            }
          });
        }
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        console.error("[home] /api/feed fetch failed", err);
        setFeedError(true);
        setFeedLoading(false);
      }
    })();
    return () => controller.abort();
  }, [feedWindow, feedReloadTick]);

  // Weather is keyed on the resolved city (not a mount-once read) so
  // picking a different city — or geolocation resolving after the picker
  // hasn't been touched — re-fetches for it; the AbortController cleanup
  // cancels the previous city's in-flight request so a slow response for it
  // can never land after the new city's and show the wrong forecast.
  useEffect(() => {
    const weatherController = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/weather?destination=${encodeURIComponent(city.name)}`, {
          signal: weatherController.signal,
        });
        const json = (await res.json()) as {
          day?: { condition: WeatherCondition; tempMaxC: number | null } | null;
        };
        if (!weatherController.signal.aborted && json.day) {
          setWeather({ condition: json.day.condition, tempC: json.day.tempMaxC });
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[home] weather fetch failed", err);
      }
    })();
    return () => weatherController.abort();
  }, [city.slug, city.name]);

  // "Notify me" alert-state is an independent, mount-once read (empty dep
  // array) with no relationship to weather/coords/feedWindow — its own
  // effect (and AbortController) so unmount/re-run actually cancels the
  // in-flight network request, not just the state update.
  useEffect(() => {
    if (!NOTIFY_ME_ENABLED) return;
    const alertsController = new AbortController();
    fetch("/api/alerts", { signal: alertsController.signal })
      .then((res) => res.json())
      .then((json: { happeningIds?: string[] }) => {
        if (!alertsController.signal.aborted) setAlertHappeningIds(new Set(json.happeningIds ?? []));
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[home] /api/alerts fetch failed", err);
      });
    return () => alertsController.abort();
  }, []);

  async function refreshNow() {
    try {
      const json = await fetchNowResponse(coords);
      setNow(json);
      setNowError(false);
    } catch (err) {
      console.error("[home] /api/now refresh failed", err);
      setNowError(true);
    }
  }

  /** Retry action for both the What's on and Book early ErrorStates — both
   *  read the same GET /api/feed response, so one retry re-runs the one
   *  effect that fetches it. */
  function retryFeed() {
    setFeedError(false);
    setFeedReloadTick((t) => t + 1);
  }

  function handlePrimary(kind: CardKind) {
    // Goes through the shared store (lib/geo.ts) rather than calling
    // getCurrentPosition directly, so the result is cached/deduped like any
    // other refresh, and the [coords] effect above re-fetches /api/now once
    // the shared `coords` actually updates (fixes a stale-closure bug where
    // this used to call refreshNow() with the *old* coords immediately
    // after asking for a new position).
    if (kind === "location") void refreshGeolocation();
  }

  const showHappeningHero = feed?.hero != null;
  const heroKind = feed?.heroKind ?? "fomo_pick";
  const whatsOnBucket = feed?.whatsOn[0] ?? null;
  const bookEarlyAll = feed?.bookEarly ?? [];
  const freeAnyTime = feed?.freeAnyTime ?? [];

  // What's on's currently-relevant list — the window's one bucket, uncapped
  // (the render below slices its first SECTION_CAP); no per-day/category
  // filtering left on Home at all — that lives on /whats-on now (reached via
  // the "See all N" link below), which fetches this same window itself.
  const whatsOnCards = whatsOnBucket?.cards ?? [];

  function cardKey(card: FeedCardData): string {
    if (card.kind === "happening") return `happening-${card.happening.id}`;
    if (card.kind === "series") return `series-${card.key}`;
    return `event-${card.event.id}`;
  }

  function whatsOnEmptyMessage(): string {
    return `Nothing lined up for ${WHATS_ON_WINDOW_LABEL[feedWindow].toLowerCase()} yet — try another tab.`;
  }

  return (
    <div className="flex flex-col gap-6 pb-6">
      {/* NOT `glass-surface` here (72% opaque) — sticky, it let scrolled
          section headings show through underneath it. A sticky app bar needs
          to actually occlude what scrolls behind it; the shared glass-surface
          utility is tuned for overlay badges and non-sticky surfaces where
          that translucency reads as intentional, not a bug, so this stays a
          local override rather than changing the utility itself out from
          under its other callers. */}
      <header className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b border-hairline bg-surface-container-lowest/95 px-4 pt-safe min-h-[64px] backdrop-blur-xl">

        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex flex-col">
            <span className="text-headline-sm font-extrabold leading-none tracking-tight text-on-surface">
              Fomo
            </span>
            <span className="mt-0.5 text-label-sm font-bold uppercase tracking-wider text-accent">
              Feed
            </span>
          </div>
          <button
            type="button"
            onClick={() => setCityPickerOpen(true)}
            aria-label={`Change city (currently ${city.name})`}
            className="ml-1 flex shrink-0 items-center gap-1 rounded-full border border-hairline bg-surface-container-lowest px-2.5 py-0.5 transition-colors hover:bg-surface-container-low"
          >
            <Icon name="location_on" size={14} className="text-secondary" />
            <span className="text-label-sm font-bold tracking-tight text-secondary">{cityBadge(city)}</span>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <div
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 ${
              weather ? WEATHER_THEME[weather.condition].chipClass : "text-on-surface-variant"
            }`}
          >
            <Icon name={weather ? WEATHER_THEME[weather.condition].icon : "partly_cloudy_day"} size={16} />
            <span className="text-label-sm font-semibold">
              {weather?.tempC != null ? `${Math.round(weather.tempC)}°` : "—°"}
            </span>
          </div>
          <Link
            href="/saved"
            aria-label="Saved"
            className="flex h-10 w-10 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
          >
            <Icon name="bookmark" size={22} />
          </Link>
          {signedIn === false ? (
            <Link
              href="/signin"
              className="ml-1 flex h-9 items-center rounded-full bg-primary px-3.5 text-label-md font-bold text-on-primary"
            >
              Sign in
            </Link>
          ) : (
            <Link href="/profile" aria-label="Profile" className="flex h-10 w-10 items-center justify-center">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-container text-on-primary">
                <Icon name="person" size={17} />
              </span>
            </Link>
          )}
        </div>
      </header>

      {/* Surfaced once, only when geolocation is denied/unsupported and the
          user has never confirmed or dismissed a city — an explicit,
          rememberable ask instead of the old silent Edinburgh fallback.
          Not a blocking modal: a dismissible inline banner that opens the
          same picker the header pill does.

          Gated on SUPPORTED_CITIES.length here (the render), not folded into
          `shouldPrompt` itself (the state): with only one supported city
          there's no actual choice to offer, so asking "which city?" is pure
          noise that costs vertical space on a mobile feed for nothing.
          `shouldPrompt` keeps computing normally off geolocation/dismissal
          state regardless, so this starts showing itself automatically the
          moment a second city is added — deliberate, not dead code. */}
      {shouldPromptCity && SUPPORTED_CITIES.length > 1 ? (
        <div className="mx-4 flex items-center gap-2 rounded-xl border border-hairline bg-surface-container-low px-3 py-2">
          <Icon name="location_off" size={18} className="text-on-surface-variant" />
          <p className="flex-1 text-body-sm text-on-surface-variant">
            Couldn&rsquo;t detect your location — showing {city.name}.
          </p>
          <button
            type="button"
            onClick={() => setCityPickerOpen(true)}
            className="shrink-0 text-label-sm font-semibold text-primary"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={dismissCityPrompt}
            aria-label="Dismiss"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      ) : null}

      <CityPicker
        open={cityPickerOpen}
        onClose={() => setCityPickerOpen(false)}
        cities={SUPPORTED_CITIES}
        currentSlug={city.slug}
        currentSource={citySource}
        onSelect={chooseCity}
      />

      <div className="flex flex-col gap-6 px-4">
        {/* Window control — drives What's on, and on Book early the hero too (see `heroKind`). */}
        <SegmentedControl value={feedWindow} options={WINDOW_OPTIONS} onChange={setWindow} />

        {showHappeningHero && feed?.hero ? (
          <FeedHero card={feed.hero} variant={heroKind} />
        ) : heroKind === "book_early" ? null : now?.hero ? (
          <FomoCard candidate={now.hero} variant="hero" onDismiss={() => void refreshNow()} onPrimary={handlePrimary} />
        ) : nowError ? (
          // A real /api/now failure — as opposed to "still loading" or "no
          // pick to show" below, neither of which are errors — so this is
          // the one case that gets a Retry instead of leaving "Finding
          // something worth your while…" on screen forever.
          <ErrorState
            title="Couldn't load today's pick"
            message="Check your connection and try again."
            onRetry={() => void refreshNow()}
            className="p-6"
          />
        ) : (
          <div
            className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-hairline-strong p-6 text-center"
            role={now === null ? "status" : undefined}
            aria-live={now === null ? "polite" : undefined}
          >
            <Icon name="explore" size={28} className="text-outline" />
            <p className="text-body-md text-on-surface-variant">
              {now?.degraded === "no-coverage"
                ? `Fomo doesn't know ${city.name} well enough yet — check the Map tab for live nearby places.`
                : "Finding something worth your while…"}
            </p>
          </div>
        )}

        {/* What's on — window-driven, one chronological list (see
            app/api/feed/route.ts's doc comment on `whatsOn`). Hidden entirely
            (heading, count badge, skeletons, empty state, all of it) on Book
            early: that tab isn't a date window at all, it's a swap-out to the
            Book Early list below, and the route returns an empty `whatsOn`
            for it so there'd be nothing here to show anyway. `scroll-mt-20`
            keeps the sticky header from covering the section top when a
            window switch scrolls it into view (see the fetch effect above). */}
        {feedWindow !== "book_early" ? (
          <div ref={whatsOnSectionRef} className="flex scroll-mt-20 flex-col gap-3">
            {feed !== null && !feedError ? (
              <div className="flex items-center justify-between px-1">
                <h2 className="text-headline-sm font-extrabold tracking-tight text-on-surface">
                  What&apos;s on
                  <span className="ml-1.5 font-semibold text-on-surface-variant">
                    · {WHATS_ON_WINDOW_LABEL[feedWindow]}
                  </span>
                </h2>
                {/* Count badge and the "See all N" link share this
                    right-aligned row — same slot on every tab (What's on
                    here, Book early below). */}
                <div className="flex items-center gap-2">
                  <span className="rounded-full border border-hairline-strong bg-surface-container px-2.5 py-0.5 text-label-sm font-extrabold text-primary">
                    {whatsOnCards.length}
                  </span>
                  <SeeAllLink href={`/whats-on?window=${feedWindow}`} total={whatsOnCards.length} />
                </div>
              </div>
            ) : null}

            {feedError ? (
              // A real GET /api/feed failure — never rendered as the
              // "Nothing lined up... try another tab" empty copy below,
              // which is reserved for a genuinely empty (but successful)
              // response.
              <ErrorState title="Couldn't load what's on" onRetry={retryFeed} />
            ) : feed === null ? (
              <div className="flex flex-col gap-3" role="status" aria-live="polite">
                <span className="sr-only">Loading what&rsquo;s on…</span>
                {[0, 1].map((i) => (
                  <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-container motion-reduce:animate-none" />
                ))}
              </div>
            ) : (
              <div
                key={whatsOnRenderKey}
                className={`feed-fade-in flex flex-col gap-3 transition-opacity duration-200 ${
                  feedLoading ? "pointer-events-none opacity-40" : "opacity-100"
                }`}
              >
                {whatsOnCards.length === 0 ? (
                  <p className="px-1 text-body-sm text-on-surface-variant">{whatsOnEmptyMessage()}</p>
                ) : (
                  whatsOnCards.slice(0, SECTION_CAP).map((card) => <FeedListCard key={cardKey(card)} card={card} />)
                )}
              </div>
            )}
          </div>
        ) : null}

        {/* Book early — its own tab (user feedback: Book Early deserved more
            room than a capped section wedged under Coming up, and competed
            with What's on for the same tab's attention). The API field
            itself stays window-independent — it's unconditionally returned
            by GET /api/feed because /book-early, /deals and /free all fetch
            window=now and depend on the full list — Home is just choosier
            about when it renders it. Same cap+"See all N" link convention as
            What's on above, out to /book-early — its own page, with its own
            timing/category/month filters and Ask Fomo button (see that
            page's own doc comment). */}
        {feedWindow === "book_early" ? (
          <section className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2 px-1">
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <Icon name="confirmation_number" size={20} className="text-accent" />
                  <h3 className="text-headline-sm font-extrabold tracking-tight text-on-surface">Book Early</h3>
                </div>
                <p className="text-label-sm text-on-surface-variant">
                  Things that sell out fast the moment tickets go on sale
                </p>
              </div>
              <SeeAllLink href="/book-early" total={bookEarlyAll.length} />
            </div>
            {feedError ? (
              <ErrorState title="Couldn't load Book Early" onRetry={retryFeed} />
            ) : feed === null ? (
              <div className="flex flex-col gap-3" role="status" aria-live="polite">
                <span className="sr-only">Loading Book Early…</span>
                {[0, 1].map((i) => (
                  <div key={i} className="h-20 animate-pulse rounded-lg bg-surface-container motion-reduce:animate-none" />
                ))}
              </div>
            ) : bookEarlyAll.length === 0 ? (
              <p className="px-1 text-body-sm text-on-surface-variant">
                Nothing worth booking early right now — check back soon.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {bookEarlyAll.slice(0, SECTION_CAP).map((card) => (
                  <BookEarlyCard
                    key={bookEarlyCardKey(card)}
                    card={card}
                    initialSubscribed={card.kind === "happening" && alertHappeningIds.has(card.happening.id)}
                  />
                ))}
              </div>
            )}
          </section>
        ) : null}

        {/* Free any time — Now only. It used to render under every tab,
            which read as repetition once Coming up and Book early each had
            their own primary content to focus on; Now (today + tomorrow) is
            the one tab short enough that "here's what's always free" still
            earns its place at the bottom rather than padding out the scroll. */}
        {feedWindow === "now" ? <FreeAnyTimeList items={freeAnyTime} /> : null}
      </div>
    </div>
  );
}
