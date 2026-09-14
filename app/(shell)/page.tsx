"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CITY, cityBadge } from "@/lib/city";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { useGeolocation } from "@/lib/geo";
import { rememberUserLocation, forgetUserLocation } from "@/lib/now/location";
import type { CardKind, NowResponse } from "@/lib/now/types";
import type { FeedCardData, FeedResponse, FeedWindow } from "@/lib/happenings/feed-types";
import { NOTIFY_ME_ENABLED } from "@/lib/happenings/book-early";
import type { WeatherCondition } from "@/lib/weather";
import { WEATHER_THEME } from "@/lib/weatherUi";
import { Icon, SegmentedControl } from "@/components/ui";
import { FomoCard } from "@/components/fomo/Card";
import { HappeningHero, FeedListCard, FreeAnyTimeList, BookEarlyCard } from "@/components/happenings";

interface HomeWeather {
  condition: WeatherCondition;
  tempC: number | null;
}

const WINDOW_OPTIONS: { value: FeedWindow; label: string }[] = [
  { value: "now", label: "Now" },
  { value: "month", label: "This month" },
  { value: "coming_up", label: "Coming up" },
];

/** What's on section header — deliberately its own wording (not the segmented
 *  control's own labels) so the header reads as "what you're looking at" ("Today
 *  & tomorrow") rather than echoing the tab name ("Now") back at the user. */
const WHATS_ON_WINDOW_LABEL: Record<FeedWindow, string> = {
  now: "Today & tomorrow",
  month: "This month",
  coming_up: "Coming up",
};

async function fetchNowResponse(
  coords: { lat: number; lng: number } | null
): Promise<NowResponse | null> {
  try {
    const params = new URLSearchParams();
    if (coords) {
      params.set("lat", String(coords.lat));
      params.set("lng", String(coords.lng));
    }
    const res = await fetch(`/api/now?${params.toString()}`);
    return (await res.json()) as NowResponse;
  } catch (err) {
    console.error("[home] /api/now fetch failed", err);
    return null;
  }
}

/** `window` drives What's on only — every other section (hero, Book early, Deals, Free any time) is independent of it, so this is the only query param the feed route still takes besides `at`. */
async function fetchFeed(window: FeedWindow): Promise<FeedResponse | null> {
  try {
    const params = new URLSearchParams({ window });
    const res = await fetch(`/api/feed?${params.toString()}`);
    return (await res.json()) as FeedResponse;
  } catch (err) {
    console.error("[home] /api/feed fetch failed", err);
    return null;
  }
}

function bookEarlyCardKey(card: FeedResponse["bookEarly"][number]): string {
  return card.kind === "happening" ? `happening-${card.happening.id}` : `event-${card.event.id}`;
}

/**
 * Fomo Home — a clean, four-section skim: Fomo Pick hero → What's on (the
 * only section the window control drives) → Book early → Free any time.
 * Deals & Offers moved out to its own page (app/(shell)/deals/page.tsx) in
 * the Home decluttering pass — user feedback was "the homepage is messy, all
 * blue, too much text", and Deals' own WHAT/WHO filter chips plus a fourth
 * card list were the single biggest chunk of that. Deals lives ONLY in the
 * bottom nav now (components/shell/BottomNav.tsx) — deliberately no pointer
 * card, teaser, or header shortcut to it anywhere on this page, so it reads
 * as a clean, separate destination rather than a Home section in disguise.
 * `deals` is still part of GET /api/feed's response (the Deals page reads
 * the same route) — Home just never touches that field.
 *
 * The merged read lives behind GET /api/feed (app/api/feed/route.ts) — this
 * page is presentation + the one piece of client state the route can't own
 * (the window).
 *
 * HERO FALLBACK: unchanged from the pre-restructure page — GET /api/feed's
 * `hero` is the top-ranked live happening across every section, or null when
 * none qualify. When it's null this renders the pre-existing /api/now hero
 * via FomoCard instead, so the page is never blank while the happenings
 * pipeline catches up.
 */
export default function HomePage() {
  const db = supabaseBrowserAuth();
  const [now, setNow] = useState<NowResponse | null>(null);
  const [feed, setFeed] = useState<FeedResponse | null>(null);
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

  // Coarse last-known location, for graceful degradation on a later cold open.
  // Not used for this request, which sends the live reading directly.
  useEffect(() => {
    if (geoStatus === "granted" && coords) void rememberUserLocation(db, coords.lat, coords.lng);
    else if (geoStatus === "denied") void forgetUserLocation(db);
  }, [db, geoStatus, coords]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const json = await fetchNowResponse(coords);
      if (!cancelled && json) setNow(json);
    })();
    return () => {
      cancelled = true;
    };
  }, [coords]);

  // Switching the window keeps the previous feed on screen
  // (stale-while-revalidate) rather than unmounting it, but it's now dimmed
  // (`feedLoading`) for immediate feedback, and cross-fades in once the new
  // window's data lands (see `whatsOnRenderKey`). Only the very first load,
  // before `feed` has ever been set, shows the plain skeleton below instead.
  useEffect(() => {
    let cancelled = false;
    const isWindowSwitch = prevFeedWindowRef.current !== feedWindow;
    prevFeedWindowRef.current = feedWindow;
    (async () => {
      setFeedLoading(true);
      const json = await fetchFeed(feedWindow);
      if (cancelled) return;
      setFeed(json);
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
    })();
    return () => {
      cancelled = true;
    };
  }, [feedWindow]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/weather?destination=${encodeURIComponent(CITY.name)}`);
        const json = (await res.json()) as {
          day?: { condition: WeatherCondition; tempMaxC: number | null } | null;
        };
        if (!cancelled && json.day) setWeather({ condition: json.day.condition, tempC: json.day.tempMaxC });
      } catch (err) {
        console.error("[home] weather fetch failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!NOTIFY_ME_ENABLED) return;
    let cancelled = false;
    fetch("/api/alerts")
      .then((res) => res.json())
      .then((json: { happeningIds?: string[] }) => {
        if (!cancelled) setAlertHappeningIds(new Set(json.happeningIds ?? []));
      })
      .catch((err) => console.error("[home] /api/alerts fetch failed", err));
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshNow() {
    const json = await fetchNowResponse(coords);
    if (json) setNow(json);
  }

  function handlePrimary(kind: CardKind) {
    if (kind === "location" && typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        () => void refreshNow(),
        () => {}
      );
    }
  }

  const showHappeningHero = feed?.hero != null;
  const whatsOn = useMemo(() => feed?.whatsOn ?? [], [feed]);
  const whatsOnCount = useMemo(() => whatsOn.reduce((sum, bucket) => sum + bucket.cards.length, 0), [whatsOn]);
  const bookEarly = feed?.bookEarly ?? [];
  const freeAnyTime = feed?.freeAnyTime ?? [];

  // Every list section shares one cap+expand convention: show the first
  // SECTION_CAP cards, reveal the rest with a "Show all N" tap that expands
  // in place (no navigation, no second request — the route already returns
  // the full list). Keyed by section id, pure display state the page owns.
  const SECTION_CAP = 4;
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  function expandSection(id: string) {
    setExpandedSections((prev) => ({ ...prev, [id]: true }));
  }
  function cardKey(card: FeedCardData): string {
    if (card.kind === "happening") return `happening-${card.happening.id}`;
    if (card.kind === "series") return `series-${card.key}`;
    return `event-${card.event.id}`;
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
          <span className="ml-1 flex shrink-0 items-center gap-1 rounded-full border border-hairline bg-surface-container-lowest px-2.5 py-0.5">
            <Icon name="location_on" size={14} className="text-secondary" />
            <span className="text-label-sm font-bold tracking-tight text-secondary">{cityBadge()}</span>
          </span>
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
            href="/profile"
            aria-label="Profile"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-container text-on-primary"
          >
            <Icon name="person" size={17} />
          </Link>
        </div>
      </header>

      <div className="flex flex-col gap-6 px-4">
        {/* Window control — drives What's on only, per the Home restructure. */}
        <SegmentedControl value={feedWindow} options={WINDOW_OPTIONS} onChange={setWindow} />

        {showHappeningHero && feed?.hero ? (
          <HappeningHero happening={feed.hero.happening} occurrence={feed.hero.occurrence} />
        ) : now?.hero ? (
          <FomoCard candidate={now.hero} variant="hero" onDismiss={() => void refreshNow()} onPrimary={handlePrimary} />
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-hairline-strong p-6 text-center">
            <Icon name="explore" size={28} className="text-outline" />
            <p className="text-body-md text-on-surface-variant">
              {now?.degraded === "no-coverage"
                ? `Fomo doesn't know ${CITY.name} well enough yet — check the Map tab for live nearby places.`
                : "Finding something worth your while…"}
            </p>
          </div>
        )}

        {/* What's on — window-driven date buckets. `scroll-mt-20` keeps the
            sticky header from covering the section top when a switch scrolls
            it into view (see the fetch effect above). */}
        <div ref={whatsOnSectionRef} className="flex scroll-mt-20 flex-col gap-3">
          {feed !== null ? (
            <div className="flex items-center justify-between px-1">
              <h2 className="text-headline-sm font-extrabold tracking-tight text-on-surface">
                What&apos;s on
                <span className="ml-1.5 font-semibold text-on-surface-variant">
                  · {WHATS_ON_WINDOW_LABEL[feedWindow]}
                </span>
              </h2>
              <span className="rounded-full border border-hairline-strong bg-surface-container px-2.5 py-0.5 text-label-sm font-extrabold text-primary">
                {whatsOnCount}
              </span>
            </div>
          ) : null}

          {feed === null ? (
            <div className="flex flex-col gap-3">
              {[0, 1].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-container motion-reduce:animate-none" />
              ))}
            </div>
          ) : (
            <div
              key={whatsOnRenderKey}
              className={`feed-fade-in flex flex-col gap-5 transition-opacity duration-200 ${
                feedLoading ? "pointer-events-none opacity-40" : "opacity-100"
              }`}
            >
              {whatsOn.length === 0 ? (
                <p className="px-1 text-body-sm text-on-surface-variant">
                  Nothing lined up for {WHATS_ON_WINDOW_LABEL[feedWindow].toLowerCase()} yet — try another tab.
                </p>
              ) : (
                whatsOn.map((bucket) => {
                  const isExpanded = expandedSections[bucket.key] ?? false;
                  const visibleCards = isExpanded ? bucket.cards : bucket.cards.slice(0, SECTION_CAP);
                  const hiddenCount = bucket.cards.length - visibleCards.length;
                  return (
                    <section key={bucket.key} className="flex flex-col gap-3">
                      <div className="flex items-center justify-between px-1">
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-accent" />
                          <h3 className="text-headline-sm font-extrabold tracking-tight text-on-surface">
                            {bucket.title}
                          </h3>
                        </div>
                        {bucket.meta ? (
                          <span className="rounded-full border border-hairline-strong bg-surface-container px-2.5 py-0.5 text-label-sm font-extrabold text-primary">
                            {bucket.meta}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex flex-col gap-3">
                        {visibleCards.map((card) => (
                          <FeedListCard key={cardKey(card)} card={card} />
                        ))}
                      </div>
                      {hiddenCount > 0 ? (
                        <button
                          type="button"
                          onClick={() => expandSection(bucket.key)}
                          className="flex items-center justify-center gap-1 rounded-lg border border-hairline py-2.5 text-label-md font-bold text-secondary transition-colors hover:bg-surface-container"
                        >
                          Show all {bucket.cards.length}
                          <Icon name="expand_more" size={16} />
                        </button>
                      ) : null}
                    </section>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Book early — always-on, independent of window. Full ranked list +
            its own timing/category/month filters and an Ask Fomo button now
            live at /book-early — see that page's own doc comment. */}
        {bookEarly.length > 0 ? (
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
              <Link
                href="/book-early"
                className="flex shrink-0 items-center gap-0.5 rounded-full bg-surface-container-lowest/80 px-2.5 py-1 text-label-sm font-semibold text-primary backdrop-blur-sm transition-opacity hover:opacity-80"
              >
                See all
                <Icon name="chevron_right" size={16} />
              </Link>
            </div>
            <div className="flex flex-col gap-3">
              {bookEarly.slice(0, SECTION_CAP).map((card) => (
                <BookEarlyCard
                  key={bookEarlyCardKey(card)}
                  card={card}
                  initialSubscribed={card.kind === "happening" && alertHappeningIds.has(card.happening.id)}
                />
              ))}
            </div>
          </section>
        ) : null}

        <FreeAnyTimeList items={freeAnyTime} />
      </div>
    </div>
  );
}
