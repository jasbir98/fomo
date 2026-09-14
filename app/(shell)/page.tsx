"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { cityBadge, SUPPORTED_CITIES } from "@/lib/city";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { refreshGeolocation, useGeolocation } from "@/lib/geo";
import { chooseCity, dismissCityPrompt, useSelectedCity } from "@/lib/useSelectedCity";
import { rememberUserLocation, forgetUserLocation } from "@/lib/now/location";
import type { CardKind, NowResponse } from "@/lib/now/types";
import type { FeedCardData, FeedResponse, FeedWindow } from "@/lib/happenings/feed-types";
import { NOTIFY_ME_ENABLED } from "@/lib/happenings/book-early";
import { localDayDate } from "@/lib/happenings/occurrence";
import { monthShort, weekendDates } from "@/lib/happenings/format";
import type { WeatherCondition } from "@/lib/weather";
import { WEATHER_THEME } from "@/lib/weatherUi";
import { Chip, CityPicker, Icon, SegmentedControl } from "@/components/ui";
import { FomoCard } from "@/components/fomo/Card";
import { HappeningHero, FeedListCard, FreeAnyTimeList, BookEarlyCard } from "@/components/happenings";

interface HomeWeather {
  condition: WeatherCondition;
  tempC: number | null;
}

/**
 * Three tabs, not a window plus a bolted-on list. "This month" used to be a
 * tab here, then a range filter chip inside Coming up; both are gone now —
 * Coming up's own date-filter row (an "All dates"/"This weekend" chip plus a
 * pill per date, see `ComingUpDateFilterRow` below) replaced it with
 * something that narrows the list the caller can actually see instead of a
 * blind lookahead cutoff. Now/Coming up are disjoint by construction
 * server-side (see occurrenceWindowRange in app/api/feed/route.ts).
 * `book_early` is the third tab, added because Book Early competed for
 * attention as a section wedged under Coming up — it's not a date window at
 * all (the route returns an empty `whatsOn` for it), it swaps out What's on
 * entirely for the ranked Book Early list.
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

async function fetchNowResponse(
  coords: { lat: number; lng: number } | null,
  signal?: AbortSignal
): Promise<NowResponse | null> {
  try {
    const params = new URLSearchParams();
    if (coords) {
      params.set("lat", String(coords.lat));
      params.set("lng", String(coords.lng));
    }
    const res = await fetch(`/api/now?${params.toString()}`, { signal });
    return (await res.json()) as NowResponse;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    console.error("[home] /api/now fetch failed", err);
    return null;
  }
}

/** `window` drives What's on (and, for `book_early`, swaps it out entirely
 *  and swaps the hero for that tab's own pick) — every other section (Deals,
 *  Free any time) is independent of it. The route also accepts `range`/
 *  `price` params (defaulting to "all" for both), but Home no longer has UI
 *  for either — see the removed Range/Price filter chips — so they're never
 *  sent. */
async function fetchFeed(window: FeedWindow, signal?: AbortSignal): Promise<FeedResponse | null> {
  try {
    const params = new URLSearchParams({ window });
    const res = await fetch(`/api/feed?${params.toString()}`, { signal });
    return (await res.json()) as FeedResponse;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    console.error("[home] /api/feed fetch failed", err);
    return null;
  }
}

function bookEarlyCardKey(card: FeedResponse["bookEarly"][number]): string {
  return card.kind === "happening" ? `happening-${card.happening.id}` : `event-${card.event.id}`;
}

/** A What's on card's local calendar day — `occurrence.dayDate` for a
 *  happening/series card, else derived from an event's `starts_at` the same
 *  way app/api/feed/route.ts's own `dayDateOf` does. Used only by Coming
 *  up's client-side date filter (the route already sorts/groups server-side;
 *  this re-derives the same day string purely for filtering the list the
 *  caller already has, not for re-bucketing it). */
function cardDayDate(card: FeedCardData): string {
  return card.kind === "event" ? localDayDate(new Date(card.event.starts_at)) : card.occurrence.dayDate;
}

/** Every list section shares one cap+expand convention: show the first
 *  SECTION_CAP cards, reveal the rest with a "Show all N" tap that expands
 *  in place (no navigation, no second request — the route already returns
 *  the full list), and collapse back with "Show less". Rendered only when
 *  there's actually more than SECTION_CAP to show. */
const SECTION_CAP = 5;

function SectionToggle({ total, expanded, onToggle }: { total: number; expanded: boolean; onToggle: () => void }) {
  if (total <= SECTION_CAP) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-surface-container-lowest/80 px-2.5 py-1 text-label-sm font-semibold text-primary backdrop-blur-sm transition-opacity hover:opacity-80"
    >
      {expanded ? "Show less" : `Show all ${total}`}
      <Icon name={expanded ? "expand_less" : "expand_more"} size={16} />
    </button>
  );
}

/** "Sep" / "26" / "Sat" for one Coming up date pill — `monthShort` (not
 *  `Intl.DateTimeFormat(…, {month:"short"})`) sidesteps the en-GB "Sept" ICU
 *  quirk lib/happenings/format.ts's own module doc calls out; weekday
 *  abbreviation is safe straight from `Intl` (no such quirk there), same as
 *  that file's own date-label helpers. */
function dayPillParts(dayDate: string): { weekday: string; day: number; month: string } {
  const [y, m, d] = dayDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(date);
  return { weekday, day: d, month: monthShort(dayDate) };
}

/**
 * Coming up's date filter — "All dates" / "This weekend" chips plus one
 * compact calendar pill per date that has at least one card, replacing the
 * old "This weekend" / "Later on" bucket split (see app/api/feed/route.ts's
 * doc comment on `whatsOn`) with something the caller can actually narrow.
 * Single-select, horizontally scrollable, no wrapping — same convention as
 * every other filter-chip row in the app (app/(shell)/events/page.tsx and
 * siblings). Purely a display of `dates`, which the page derives from the
 * already-fetched card list — no fetch of its own.
 */
function ComingUpDateFilterRow({
  dates,
  selected,
  onSelect,
}: {
  dates: string[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [&::-webkit-scrollbar]:hidden">
      <Chip label="All dates" selected={selected === "all"} onClick={() => onSelect("all")} />
      <Chip label="This weekend" selected={selected === "weekend"} onClick={() => onSelect("weekend")} />
      {dates.map((dayDate, i) => {
        const { weekday, day, month } = dayPillParts(dayDate);
        const showMonth = i === 0 || dayPillParts(dates[i - 1]).month !== month;
        const active = selected === dayDate;
        return (
          <button
            key={dayDate}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(dayDate)}
            className={`flex min-w-[44px] shrink-0 flex-col items-center gap-0.5 rounded-2xl px-2.5 py-1.5 text-center transition-colors ${
              active
                ? "bg-primary text-on-primary border border-primary shadow-sm"
                : "bg-surface-container text-on-surface-variant border border-transparent hover:bg-surface-container-high"
            }`}
          >
            <span className="h-3 text-[9px] font-bold uppercase leading-none tracking-wide opacity-70">
              {showMonth ? month : ""}
            </span>
            <span className="text-[10px] font-semibold uppercase leading-none">{weekday}</span>
            <span className="text-label-md font-extrabold leading-none">{day}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Fomo Home — a clean, tab-driven skim: a hero card → then, depending on the
 * window control, either What's on (Now/Coming up) or the Book early list
 * (its own tab, not a section wedged under Coming up) → Free any time, shown
 * only on Now so it doesn't repeat itself under every tab. Every list here
 * (What's on, Book early) shows its first SECTION_CAP cards with a "Show all
 * N" control that expands in place — no per-section chip filters left on
 * Home; Coming up's own date-filter row is the one exception, since it
 * narrows a list the caller is already looking at rather than gating the
 * fetch. Deals & Offers moved out to its own page (app/(shell)/deals/page.tsx)
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
 * page is presentation + the client state the route can't own (the window,
 * Coming up's date filter).
 *
 * HERO: GET /api/feed's `hero` is ordinarily the top-ranked live happening
 * across every section, rendered via HappeningHero; null falls back to the
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
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [weather, setWeather] = useState<HomeWeather | null>(null);
  const [feedWindow, setWindow] = useState<FeedWindow>("now");
  // Coming up's date filter — "all", "weekend", or a specific "YYYY-MM-DD"
  // day pill. Purely client-side over the already-fetched `whatsOn` list (no
  // refetch), so — unlike `feedWindow` — changing it never triggers the
  // fetch effect or the scroll-into-view below.
  const [comingUpDateFilter, setComingUpDateFilter] = useState<string>("all");
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
  // Coming up's date-filter row sticks directly beneath the header — its
  // `top` offset is the header's own real rendered height (which already
  // bakes in `pt-safe`'s env(safe-area-inset-top), so this never guesses a
  // pixel number that'd be wrong on a notched device). Measured the same way
  // SegmentedControl measures its sliding indicator: synchronously after
  // paint, then re-measured on resize/orientation change, since the safe
  // area inset itself can change then.
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  useEffect(() => {
    function measureHeader() {
      const el = headerRef.current;
      if (el) setHeaderHeight(el.getBoundingClientRect().height);
    }
    measureHeader();
    window.addEventListener("resize", measureHeader);
    return () => window.removeEventListener("resize", measureHeader);
  }, []);
  // Book Early "Notify me" state — the caller's full on-sale-alert
  // happening-id set, loaded once so each BookEarlyCard renders correctly
  // subscribed instead of resetting to "Notify me" on every load. Only
  // fetched when the feature is actually on (NEXT_PUBLIC_VAPID_PUBLIC_KEY
  // set) — no reason to hit /api/alerts on every Home load otherwise.
  const [alertHappeningIds, setAlertHappeningIds] = useState<Set<string>>(new Set());
  const { coords, status: geoStatus } = useGeolocation();
  const { city, source: citySource, shouldPrompt: shouldPromptCity } = useSelectedCity();
  const [cityPickerOpen, setCityPickerOpen] = useState(false);

  // Coarse last-known location, for graceful degradation on a later cold open.
  // Not used for this request, which sends the live reading directly.
  useEffect(() => {
    if (geoStatus === "granted" && coords) void rememberUserLocation(db, coords.lat, coords.lng);
    else if (geoStatus === "denied") void forgetUserLocation(db);
  }, [db, geoStatus, coords]);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const json = await fetchNowResponse(coords, controller.signal);
      if (!controller.signal.aborted && json) setNow(json);
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
      const json = await fetchFeed(feedWindow, controller.signal);
      if (controller.signal.aborted) return;
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
    return () => controller.abort();
  }, [feedWindow]);

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
    const json = await fetchNowResponse(coords);
    if (json) setNow(json);
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

  // Coming up's date filter operates over this one already-fetched list —
  // see app/api/feed/route.ts's doc comment on `whatsOn` for why it's a
  // single chronological bucket now, not a weekend/later split. Memoized in
  // its own right (not just inlined into the two useMemos below) so THEIR
  // deps are a stable reference across renders that don't actually change
  // window/bucket, not a fresh `[]`/slice every time.
  const comingUpAllCards = useMemo(
    () => (feedWindow === "coming_up" ? (whatsOnBucket?.cards ?? []) : []),
    [feedWindow, whatsOnBucket]
  );
  const comingUpDates = useMemo(() => {
    const set = new Set<string>();
    for (const card of comingUpAllCards) set.add(cardDayDate(card));
    return Array.from(set).sort();
  }, [comingUpAllCards]);
  const { saturday: weekendSaturday, sunday: weekendSunday } = weekendDates();
  const comingUpFilteredCards = useMemo(() => {
    if (comingUpDateFilter === "all") return comingUpAllCards;
    if (comingUpDateFilter === "weekend") {
      return comingUpAllCards.filter((c) => {
        const d = cardDayDate(c);
        return d === weekendSaturday || d === weekendSunday;
      });
    }
    return comingUpAllCards.filter((c) => cardDayDate(c) === comingUpDateFilter);
  }, [comingUpAllCards, comingUpDateFilter, weekendSaturday, weekendSunday]);

  // What's on's currently-relevant list — Coming up's date-filtered cards, or
  // the window's one bucket as-is for Now (which has no filter row).
  const whatsOnCards = feedWindow === "coming_up" ? comingUpFilteredCards : (whatsOnBucket?.cards ?? []);

  // Cap+expand state for What's on and Book early — each tab shows only ONE
  // of these at a time, so one boolean per section (not keyed by bucket, now
  // that a window is ever at most one bucket) is enough. Reset whenever the
  // caller changes what they're looking at, so a stale "expanded" never
  // carries over onto a different tab or date — React's own "adjusting state
  // when a prop changes" pattern (react.dev/learn/you-might-not-need-an-effect):
  // track the last-seen `feedWindow`/`comingUpDateFilter` in state and
  // setState immediately during render when either has moved, rather than in
  // a `useEffect`, which would commit one stale frame first and cost an
  // avoidable extra render.
  const [expandedWhatsOn, setExpandedWhatsOn] = useState(false);
  const [expandedBookEarly, setExpandedBookEarly] = useState(false);
  const [prevFeedWindowForReset, setPrevFeedWindowForReset] = useState(feedWindow);
  const [prevDateFilterForReset, setPrevDateFilterForReset] = useState(comingUpDateFilter);
  if (feedWindow !== prevFeedWindowForReset) {
    setPrevFeedWindowForReset(feedWindow);
    setPrevDateFilterForReset("all");
    setExpandedWhatsOn(false);
    setExpandedBookEarly(false);
    if (comingUpDateFilter !== "all") setComingUpDateFilter("all");
  } else if (comingUpDateFilter !== prevDateFilterForReset) {
    setPrevDateFilterForReset(comingUpDateFilter);
    setExpandedWhatsOn(false);
  }

  function cardKey(card: FeedCardData): string {
    if (card.kind === "happening") return `happening-${card.happening.id}`;
    if (card.kind === "series") return `series-${card.key}`;
    return `event-${card.event.id}`;
  }

  function whatsOnEmptyMessage(): string {
    if (feedWindow === "coming_up" && comingUpDateFilter !== "all" && comingUpAllCards.length > 0) {
      return "Nothing on that day — try another date.";
    }
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
      <header
        ref={headerRef}
        className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b border-hairline bg-surface-container-lowest/95 px-4 pt-safe min-h-[64px] backdrop-blur-xl"
      >
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
            href="/profile"
            aria-label="Profile"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-container text-on-primary"
          >
            <Icon name="person" size={17} />
          </Link>
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
          <HappeningHero happening={feed.hero.happening} occurrence={feed.hero.occurrence} variant={heroKind} />
        ) : heroKind === "book_early" ? null : now?.hero ? (
          <FomoCard candidate={now.hero} variant="hero" onDismiss={() => void refreshNow()} onPrimary={handlePrimary} />
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-hairline-strong p-6 text-center">
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
            {feed !== null ? (
              <div className="flex items-center justify-between px-1">
                <h2 className="text-headline-sm font-extrabold tracking-tight text-on-surface">
                  What&apos;s on
                  <span className="ml-1.5 font-semibold text-on-surface-variant">
                    · {WHATS_ON_WINDOW_LABEL[feedWindow]}
                  </span>
                </h2>
                {/* Count badge and the "Show all N" toggle share this
                    right-aligned row — user feedback asked for the expand
                    control "on the side", next to the section's own count,
                    same slot on every tab (What's on here, Book early
                    below). */}
                <div className="flex items-center gap-2">
                  <span className="rounded-full border border-hairline-strong bg-surface-container px-2.5 py-0.5 text-label-sm font-extrabold text-primary">
                    {whatsOnCards.length}
                  </span>
                  <SectionToggle
                    total={whatsOnCards.length}
                    expanded={expandedWhatsOn}
                    onToggle={() => setExpandedWhatsOn((v) => !v)}
                  />
                </div>
              </div>
            ) : null}

            {feedWindow === "coming_up" && feed !== null && comingUpDates.length > 0 ? (
              // Sticks directly beneath the app header (`top: headerHeight`,
              // measured above — never a guessed pixel value) as the list
              // scrolls past it, same reasoning as the header's own comment
              // on why it isn't the translucent `glass-surface` utility: a
              // sticky bar has to actually occlude what scrolls under it.
              // `z-30` keeps it below the header's own `z-40` when both are
              // stuck at once. Only this row sticks — the SegmentedControl
              // tabs above scroll away normally.
              <div
                className="sticky z-30 -mx-4 border-b border-hairline bg-surface-container-lowest/95 px-4 py-2 backdrop-blur-xl"
                style={{ top: headerHeight }}
              >
                <ComingUpDateFilterRow
                  dates={comingUpDates}
                  selected={comingUpDateFilter}
                  onSelect={setComingUpDateFilter}
                />
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
                className={`feed-fade-in flex flex-col gap-3 transition-opacity duration-200 ${
                  feedLoading ? "pointer-events-none opacity-40" : "opacity-100"
                }`}
              >
                {whatsOnCards.length === 0 ? (
                  <p className="px-1 text-body-sm text-on-surface-variant">{whatsOnEmptyMessage()}</p>
                ) : (
                  (expandedWhatsOn ? whatsOnCards : whatsOnCards.slice(0, SECTION_CAP)).map((card) => (
                    <FeedListCard key={cardKey(card)} card={card} />
                  ))
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
            about when it renders it. Same cap+expand convention as What's on
            now (was the full ranked list up front, with a "See all" link out
            to /book-early) — the toggle sits in this section's own header
            row, same right-aligned slot as What's on's. /book-early still
            exists for its own timing/category/month filters and Ask Fomo
            button (see that page's own doc comment); it's just no longer the
            only way to see past the first few from Home. */}
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
              <SectionToggle
                total={bookEarlyAll.length}
                expanded={expandedBookEarly}
                onToggle={() => setExpandedBookEarly((v) => !v)}
              />
            </div>
            {bookEarlyAll.length === 0 ? (
              <p className="px-1 text-body-sm text-on-surface-variant">
                Nothing worth booking early right now — check back soon.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {(expandedBookEarly ? bookEarlyAll : bookEarlyAll.slice(0, SECTION_CAP)).map((card) => (
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
