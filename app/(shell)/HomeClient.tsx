"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CITY, cityBadge, SUPPORTED_CITIES } from "@/lib/city";
import { chooseCity, dismissCityPrompt, useSelectedCity } from "@/lib/useSelectedCity";
import { prefetchJson, useCachedJson } from "@/lib/http/clientCache";
import type { FeedCardData, FeedResponse, FeedWindow } from "@/lib/happenings/feed-types";
import { NOTIFY_ME_ENABLED } from "@/lib/happenings/book-early";
import type { WeatherCondition } from "@/lib/weather";
import { CityPicker, ErrorState, FeedbackLink, Icon, SeeAllButton, SegmentedControl } from "@/components/ui";
import { AppHeader } from "@/components/shell/AppHeader";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { AnyDaySection, FeedHero, FeedListCard, FreeAnyTimeList, BookEarlyCard, KidsRail, SubscribeCard } from "@/components/happenings";
import { TodaysDealsStrip } from "@/components/happenings/TodaysDealsStrip";
import { NearNowSection } from "@/components/happenings/NearNowSection";
import { todaysDeals } from "@/lib/happenings/today-deals";
import { occurrenceIsPastLocalHours } from "@/lib/happenings/local-hours";
import { leadWithPhotos } from "@/lib/happenings/hero";
import { topPicks } from "@/lib/personalise/top-picks";
import { KIDS_RAIL_MIN, kidsRailCards } from "@/lib/happenings/kids-rail";
import { weekendDates } from "@/lib/happenings/format";
import { AmbientWeather } from "@/components/weather/AmbientWeather";
import { usePrefs } from "@/lib/personalise/usePrefs";
import { AudienceAsk, audienceLabels } from "@/components/personalise/AudienceAsk";
import { openMakeFomoYours } from "@/lib/personalise/trigger";
import { personalBoost, reorderWithBoost, type BoostPrefs } from "@/lib/personalise/score";
import { useEffectiveWho } from "@/lib/personalise/useEffectiveWho";
import { useAffinity } from "@/lib/personalise/useAffinity";
import { useSignedIn } from "@/lib/useSaved";
import { londonDayKey, rotateDaily } from "@/lib/personalise/freshness";
import type { RankedDealItem } from "@/lib/happenings/venue-deals";
import { track } from "@/lib/analytics/track";
import { useNow } from "@/lib/useNow";

interface HomeWeather {
  condition: WeatherCondition;
  tempC: number | null;
  // Carried through only for AmbientWeather's rain-intensity split — not
  // shown anywhere as text, so unlike `condition`/`tempC` there's no chip
  // copy relying on these.
  precipitationProbabilityMax: number | null;
  windSpeedMaxKmh: number | null;
}

// Staleness windows for lib/http/clientCache.ts's `useCachedJson` — chosen to
// mirror the server's own browser-cache promises in lib/http/cache.ts (can't
// import that file directly, it's `import "server-only"`) rather than
// inventing new numbers: `feed` tracks CACHE_SHORT's 60s, weather tracks
// CACHE_LONG's 10min, alerts (a caller-scoped membership set, not a catalogue
// that drifts minute to minute) gets a middle-ground 5min.
const FEED_STALE_MS = 60_000;
const WEATHER_STALE_MS = 10 * 60_000;
const ALERTS_STALE_MS = 5 * 60_000;

/** `requestIdleCallback` with a `setTimeout` fallback for Safari — used to prefetch the two windows the visitor isn't currently on without competing with the current window's own fetch/render. Returns a canceller for effect cleanup. */
function scheduleIdle(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(cb);
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(cb, 200);
  return () => window.clearTimeout(id);
}

/**
 * Three tabs, not a window plus a bolted-on list. "This month" used to be a
 * tab here, then a range filter chip inside Coming up; both are gone now.
 * Today/Coming up are disjoint by construction (Today = the rest of today, `window=now` in the URL/API; Coming up = tomorrow onwards) server-side (see
 * occurrenceWindowRange in app/api/feed/route.ts). `book_early` is the third
 * tab, added because Book early competed for attention as a section wedged
 * under Coming up — it's not a date window at all (the route returns an
 * empty `whatsOn` for it), it swaps out What's on entirely for the ranked
 * Book early list.
 *
 * Neither Today nor Coming up has any per-day/category filtering here anymore
 * — that used to be an in-place "Show all N" expander plus (Coming up only)
 * a sticky date-pill row bolted onto this page. Both moved to their own
 * destination, app/(shell)/whats-on/page.tsx, reached via each list's
 * "See all N" link below — the filters live where the full list does, not
 * wedged into Home.
 */
const WINDOW_OPTIONS: { value: FeedWindow; label: string }[] = [
  { value: "now", label: "Today" },
  { value: "coming_up", label: "Coming up" },
  { value: "book_early", label: "Book early" },
];

/** What's on section header — deliberately its own wording (not the segmented
 *  control's own labels) so the header reads as "what you're looking at" rather than echoing the tab
 *  name back at the user.
 *  `book_early` still needs an entry (this is a `Record<FeedWindow, string>`),
 *  but What's on is never rendered on that tab — see the section gating below
 *  — so this value is unreachable rather than a real piece of copy. */
const WHATS_ON_WINDOW_LABEL: Record<FeedWindow, string> = {
  now: "Today",
  coming_up: "Coming up",
  book_early: "Book early",
};

/** `window` drives What's on (and, for `book_early`, swaps it out entirely
 *  and swaps the hero for that tab's own pick) — every other section (Deals,
 *  Free any time) is independent of it. The route also accepts `range`/
 *  `price` params (defaulting to "all" for both), but Home no longer has UI
 *  for either — see the removed Range/Price filter chips — so they're never
 *  sent. */
// Throws on abort (caller distinguishes that from a real failure) or a
// non-2xx status (GET /api/feed's catch block returns 401/500, not a silent
// 200 with empty sections) — so `feedError` below only fires for "nothing to
// show and the last attempt failed", not a background revalidation hiccup
// with good data still on screen.
async function fetchFeed(window: FeedWindow, signal?: AbortSignal): Promise<FeedResponse> {
  const params = new URLSearchParams({ window });
  const res = await fetch(`/api/feed?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`GET /api/feed ${res.status}`);
  return (await res.json()) as FeedResponse;
}

/** `/api/weather` doesn't error-throw on a bad/empty day (matches the original
 *  effect's behaviour: a missing `day` just leaves the chip showing
 *  "unavailable" rather than an error state — weather is decor, not a thing
 *  worth a Retry button over). */
async function fetchWeather(cityName: string, signal?: AbortSignal): Promise<HomeWeather | null> {
  const res = await fetch(`/api/weather?destination=${encodeURIComponent(cityName)}`, { signal });
  const json = (await res.json()) as {
    day?: {
      condition: WeatherCondition;
      tempMaxC: number | null;
      precipitationProbabilityMax: number | null;
      windSpeedMaxKmh: number | null;
    } | null;
  };
  return json.day
    ? {
        condition: json.day.condition,
        tempC: json.day.tempMaxC,
        precipitationProbabilityMax: json.day.precipitationProbabilityMax,
        windSpeedMaxKmh: json.day.windSpeedMaxKmh,
      }
    : null;
}

/** Returns the raw id list, not a `Set` — a `Set` doesn't round-trip through
 *  `JSON.stringify` (what `clientCache`'s sessionStorage mirror needs), so
 *  the `Set` is built once at the render site from this array instead. */
async function fetchAlertIds(signal?: AbortSignal): Promise<string[]> {
  const res = await fetch("/api/alerts", { signal });
  const json = (await res.json()) as { happeningIds?: string[] };
  return json.happeningIds ?? [];
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

/** Slim, dismissible "Make Fomo yours" banner (task brief §2). A component (not inline JSX) because Home renders it twice — the phone column copy (`lg:hidden`) and the desktop right-rail copy — see the layout comment in HomePage's return. Both copies are stateless, driven by the same `prefs`. */
function MakeFomoYoursBanner({ onDismiss, className = "" }: { onDismiss: () => void; className?: string }) {
  return (
    <div className={`flex items-center gap-2 rounded-xl border border-hairline bg-surface-container-low px-3 py-2 ${className}`}>
      <button
        type="button"
        onClick={() => openMakeFomoYours()}
        className="flex min-h-[44px] flex-1 items-center gap-1.5 text-left text-label-md font-semibold text-primary"
      >
        <Icon name="tune" size={16} />
        Make Fomo yours
        <Icon name="chevron_right" size={16} />
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container"
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

export interface HomeClientProps {
  /**
   * The `now` feed built on the server (app/(shell)/page.tsx), so the first
   * HTML already holds the real list instead of a skeleton. Only a fallback
   * for the Today tab until the client's own cached/fetched copy arrives; it
   * is never written into the shared feed cache, which other pages read
   * expecting the full response.
   */
  initialFeed?: FeedResponse | null;
}

/**
 * Fomo Home — a clean, tab-driven skim. The first mobile screen does three
 * jobs: says what Fomo is (the h1 + intro), asks who you are (the inline
 * audience chips, components/personalise/AudienceAsk.tsx) and starts a short
 * ranked list (Top picks), with the weekly email form in the first scroll
 * right after it. Then, depending on the
 * window control, either What's on (Today/Coming up) or the Book early list
 * (its own tab, not a section wedged under Coming up) → Free any time, shown
 * only on Today so it doesn't repeat itself under every tab. Every list here
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
 * HERO: only on the Book early tab now. There `heroKind === "book_early"`
 * means GET /api/feed's `hero` is that tab's own top pick (HappeningHero's
 * `variant="book_early"`), and `hero: null` means no hero at all. On Today
 * and Coming up the single hero card was dropped in favour of the Top picks
 * list leading the page: the hero was the same ranking's number one
 * (lib/happenings/hero.ts feeds both), and as one big card it filled the
 * first screen, often with a pricey gig, where five short picks show range.
 */
export function HomeClient({ initialFeed = null }: HomeClientProps) {
  const [feedWindow, setWindow] = useState<FeedWindow>("now");
  // Keep the hero's schedule cutoff live in an open tab too. The API filters
  // using its request time, but cached feed data otherwise survives past a
  // happening's local closing time without any state change to rerender it.
  const [localClock, setLocalClock] = useState<Date | null>(null);
  useEffect(() => {
    const initialTick = window.setTimeout(() => setLocalClock(new Date()), 0);
    const interval = window.setInterval(() => setLocalClock(new Date()), 15_000);
    return () => {
      window.clearTimeout(initialTick);
      window.clearInterval(interval);
    };
  }, []);
  // Which way the content swap below the segmented control should slide in
  // from — derived from the tapped tab's index relative to the previous one
  // (right-of-current tab tapped ⇒ new content enters from the right, and
  // vice versa), consumed by `windowSlideClass` below. Not reset on mount:
  // the very first render never plays an entrance animation anyway (nothing
  // is keyed/remounted until `feedWindow` actually changes).
  const [switchDirection, setSwitchDirection] = useState<1 | -1>(1);
  // Brief "Showing N coming up ↓" pill under the control after a tab switch
  // — a second, ~2s-lived signal that something changed, for the case where
  // the new hero/list happens to render at roughly the same height as the
  // old one and the motion alone is easy to miss. Tap scrolls to the list
  // (same target the auto-scroll effect uses) and dismisses it early.
  const [switchToast, setSwitchToast] = useState<{ label: string } | null>(null);
  const switchToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingToastRef = useRef(false);
  const whatsOnSectionRef = useRef<HTMLDivElement>(null);
  const bookEarlySectionRef = useRef<HTMLDivElement>(null);
  // Content height of the last successfully-rendered What's on list, kept as
  // a plain ref (not state — writing it must never itself trigger a render)
  // so an uncached window switch can hold the section at that height while
  // its 4-card skeleton shows, instead of the page jumping as the skeleton's
  // own (different) height briefly applies.
  const whatsOnContentRef = useRef<HTMLDivElement>(null);
  // State, not a ref: it's read during render (the skeleton's `minHeight`),
  // and reading a ref's `.current` during render trips the
  // react-hooks/refs lint rule (and is unsafe under concurrent rendering).
  const [lastWhatsOnHeight, setLastWhatsOnHeight] = useState<number | undefined>(undefined);
  // Set once per actual window switch (never on a background revalidation of
  // the window already on screen), consumed by the scroll-into-view effect
  // below the instant that window's data — cached or freshly fetched — is
  // actually ready to show.
  const pendingScrollRef = useRef(false);
  const prevFeedWindowRef = useRef<FeedWindow>(feedWindow);
  // The page clock: the server's build time while hydrating (the first HTML
  // was ranked and labelled with it), the real time after. See lib/useNow.tsx.
  const now = useNow();
  const prefs = usePrefs();
  // The visitor's eligibility set: the account's when signed in, this
  // device's own answers (the audience ask under the intro) when signed out.
  // See useEffectiveWho's doc comment.
  const dealWho = useEffectiveWho();
  // Anyone who has answered the inline audience ask (or the sheet's
  // eligibility questions) has no need for the "Make Fomo yours" banner.
  const audienceAnswered = audienceLabels(prefs.draft).length > 0;
  const showPrefsBanner = !prefs.done && !audienceAnswered;
  const affinity = useAffinity();
  const { city, source: citySource, shouldPrompt: shouldPromptCity } = useSelectedCity();
  const [cityPickerOpen, setCityPickerOpen] = useState(false);

  // What's on / Book early — one cache key per window, which is what makes
  // Today → Coming up feel instant: switching `feedWindow` just points
  // `useCachedJson` at a different (often already-warm, see the prefetch
  // effect below) key, so cached data reappears synchronously in the same
  // render as the switch, no dim/skeleton needed. `feedError` again only
  // means "nothing to show, and it failed" — a stale-but-present feed keeps
  // rendering through a failed background revalidation (see
  // `feedResult.isValidating`'s progress-bar treatment below instead).
  const feedResult = useCachedJson<FeedResponse>(`feed:${feedWindow}`, (signal) => fetchFeed(feedWindow, signal), {
    staleMs: FEED_STALE_MS,
  });
  const feed = feedResult.data ?? (feedWindow === "now" ? initialFeed : null);
  const feedError = feedResult.error != null && feed === null;

  // "Out with the kids" rail — only for a visitor who said "I've got kids"
  // (`prefs.kids` is false on the server and through hydration, and while
  // signed out, so there's no mismatch). `key: null` skips both fetches
  // otherwise; the keys are the ones Today/Coming up already use, so they are
  // usually warm. Today's window stands in for itself when it's the active tab.
  const kidsNowResult = useCachedJson<FeedResponse>(prefs.kids ? "feed:now" : null, (signal) => fetchFeed("now", signal), {
    staleMs: FEED_STALE_MS,
  });
  const kidsLaterResult = useCachedJson<FeedResponse>(prefs.kids ? "feed:coming_up" : null, (signal) => fetchFeed("coming_up", signal), {
    staleMs: FEED_STALE_MS,
  });
  const kidsNowFeed = kidsNowResult.data ?? (feedWindow === "now" ? feed : null);
  const kidsRail = useMemo(
    () =>
      prefs.kids && kidsNowFeed
        ? kidsRailCards(kidsNowFeed, kidsLaterResult.data, weekendDates(), dealWho)
        : [],
    [prefs.kids, kidsNowFeed, kidsLaterResult.data, dealWho]
  );

  // Weather — keyed on the resolved city so switching city (or geolocation
  // resolving after the picker hasn't been touched) fetches its own cache
  // slot rather than clobbering another city's reading.
  const weatherResult = useCachedJson<HomeWeather | null>(
    `weather:${city.slug}`,
    (signal) => fetchWeather(city.name, signal),
    { staleMs: WEATHER_STALE_MS }
  );
  const weather = weatherResult.data ?? null;

  // Book early "Notify me" membership — the caller's full on-sale-alert
  // happening-id set, so each BookEarlyCard renders correctly subscribed
  // instead of resetting to "Notify me" on every load. `key: null` when the
  // feature's off (NEXT_PUBLIC_VAPID_PUBLIC_KEY unset) disables the fetch
  // entirely — same as the old `if (!NOTIFY_ME_ENABLED) return` guard. Alerts
  // need an account, so it's also off unless signed in (the route 401s).
  const signedIn = useSignedIn();
  const alertsResult = useCachedJson<string[]>(NOTIFY_ME_ENABLED && signedIn === true ? "alerts" : null, fetchAlertIds, {
    staleMs: ALERTS_STALE_MS,
  });
  const alertHappeningIds = useMemo(() => new Set(alertsResult.data ?? []), [alertsResult.data]);

  // Mark a scroll-into-view (and the switch toast below) as owed the instant
  // the window actually changes (not on a same-window revalidation) — the
  // effects below fire once `feed` for the new window is actually
  // populated, whether that's this tick (cache hit) or several ticks later
  // (cold fetch).
  useEffect(() => {
    if (prevFeedWindowRef.current !== feedWindow) {
      pendingScrollRef.current = true;
      pendingToastRef.current = true;
      prevFeedWindowRef.current = feedWindow;
    }
  }, [feedWindow]);

  // Timer cleanup on unmount only — a fresh switch clears/replaces its own
  // pending timer inline (see the toast effect below), this just stops a
  // stray one firing after the page itself is gone.
  useEffect(() => {
    return () => {
      if (switchToastTimerRef.current) clearTimeout(switchToastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!pendingScrollRef.current || feed === null) return;
    pendingScrollRef.current = false;
    // Make the change unmissable when the newly-active section isn't
    // currently in view — only scrolls when its top is below the fold
    // (never yanks the page for a section already on screen, and never
    // scrolls upward). Book early gets its own ref (its section renders
    // further down the page than What's on's).
    requestAnimationFrame(() => {
      const el = feedWindow === "book_early" ? bookEarlySectionRef.current : whatsOnSectionRef.current;
      if (!el || typeof window === "undefined") return;
      const top = el.getBoundingClientRect().top;
      if (top > window.innerHeight) {
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      }
    });
  }, [feed, feedWindow]);

  // Remember the rendered height of a loaded What's on list so a later
  // uncached window switch can hold the section at that height under its
  // skeleton instead of the page jumping.
  useEffect(() => {
    if (feed !== null && whatsOnContentRef.current) {
      setLastWhatsOnHeight(whatsOnContentRef.current.offsetHeight);
    }
  }, [feed]);

  // Once the current window has data, warm the other two windows' cache
  // entries in the background (idle time, so it never competes with the
  // window actually on screen) — this is what makes a *later* switch to
  // either of them instant too, not just a switch back to one already
  // visited this session.
  useEffect(() => {
    if (feed === null) return;
    return scheduleIdle(() => {
      for (const { value } of WINDOW_OPTIONS) {
        if (value === feedWindow) continue;
        prefetchJson(`feed:${value}`, (signal) => fetchFeed(value, signal), FEED_STALE_MS);
      }
    });
  }, [feedWindow, feed]);

  function retryFeed() {
    feedResult.revalidate();
  }

  const heroPastLocalHours =
    localClock !== null &&
    feed?.hero?.kind === "happening" &&
    occurrenceIsPastLocalHours(feed.hero.happening.time_note, feed.hero.occurrence.dayDate, localClock, CITY.timezone);
  const showHappeningHero = feed?.hero != null && !heroPastLocalHours;
  const heroKind = feed?.heroKind ?? "fomo_pick";
  const whatsOnBucket = feed?.whatsOn[0] ?? null;
  const anyDayBucket = feed?.anyDay ?? null;
  const bookEarlyAll = feed?.bookEarly ?? [];
  const freeAnyTime = feed?.freeAnyTime ?? [];

  // "Today's deals" strip — deals valid TODAY in Edinburgh time, derived
  // client-side from the same `deals` section every window already carries
  // (lib/happenings/today-deals.ts). Independent of `feedWindow`, same as
  // Book early/Free any time's own data; recomputed only when `feed` or the
  // visitor's deal profile actually changes, not on every render.
  const todaysDealsList = useMemo(
    () => (feed ? todaysDeals(feed.deals, now, { who: dealWho }) : []),
    [feed, now, dealWho]
  );

  // What's on's currently-relevant list — the window's one bucket, uncapped
  // (the render below slices its first SECTION_CAP); no per-day/category
  // filtering left on Home at all — that lives on /whats-on now (reached via
  // the "See all N" link below), which fetches this same window itself.
  // The best photo-led, free-or-cheap, soonest cards lead (hero.ts
  // `leadWithPhotos`), so the first screen under the hero is never a
  // timetable or a default tile.
  const whatsOnCards = useMemo(
    () => leadWithPhotos(whatsOnBucket?.cards ?? [], now, CITY.timezone, dealWho),
    [whatsOnBucket, now, dealWho]
  );

  // Personalisation ranking boost (lib/personalise/score.ts) — nudges, never
  // filters: every card above still renders, `reorderWithBoost` just moves a
  // matching one up by at most a few positions so the time-ordered feel of
  // What's on survives (task brief §3). `dealWho` (not `prefs`'s own toggle
  // fields) is the actual persisted eligibility set — lib/personalise/
  // usePrefs.ts writes it through lib/useSaved.ts's `setWhoGroups`, which is
  // what every "You qualify" badge already reads too, so the boost and the
  // badge can never disagree about who qualifies.
  const boostPrefs: BoostPrefs = useMemo(
    () => ({ interests: prefs.interests, budget: prefs.budget, who: dealWho, kids: prefs.kids }),
    [prefs.interests, prefs.budget, dealWho, prefs.kids]
  );
  // "Top picks": the section's SECTION_CAP cards are chosen, not just the first
  // five in time order — the For you ranking (hero score + the visitor's taste,
  // lib/personalise/top-picks.ts), each with a one-line reason. "See all N"
  // still counts and links the whole window.
  // Same rule as For you: once the visitor has answered "I'm a…", an empty
  // `who` means "none of these groups", so a Working visitor isn't shown
  // student-only picks.
  const whoKnown = prefs.status !== null || dealWho.length > 0;
  const whatsOnTopPicks = useMemo(
    () => topPicks(whatsOnCards, { prefs: boostPrefs, affinity, whoKnown, now, timeZone: CITY.timezone, count: SECTION_CAP }).picks,
    [whatsOnCards, boostPrefs, affinity, whoKnown, now]
  );
  // "Any day" (lib/happenings/everyday.ts) — boosted within its own section,
  // never merged into the dated list above. Rotated daily first
  // (lib/personalise/freshness.ts): these have no natural order, so without it
  // the same three led the section on every visit.
  const anyDayCards = useMemo(() => rotateDaily(anyDayBucket?.cards ?? [], londonDayKey(now)), [anyDayBucket, now]);
  const boostedAnyDayCards = useMemo(
    () => reorderWithBoost(anyDayCards, (card) => personalBoost(card, boostPrefs, affinity)),
    [anyDayCards, boostPrefs, affinity]
  );
  const boostedTodaysDeals = useMemo(
    () =>
      reorderWithBoost(todaysDealsList, (item: RankedDealItem) =>
        personalBoost(item.kind === "group" ? item.offers[0] : item.card, boostPrefs, affinity)
      ),
    [todaysDealsList, boostPrefs, affinity]
  );

  function cardKey(card: FeedCardData): string {
    if (card.kind === "happening") return `happening-${card.happening.id}`;
    if (card.kind === "series") return `series-${card.key}`;
    if (card.kind === "recurring") return `recurring-${card.key}`;
    return `event-${card.event.id}`;
  }

  function whatsOnEmptyMessage(): string {
    return `Nothing lined up for ${WHATS_ON_WINDOW_LABEL[feedWindow].toLowerCase()} yet. Try another tab.`;
  }

  // No counts on Home: "53 things on today" made the app read like a
  // directory to sift through, not a few good picks. "See all N" stays.
  function toastLabelFor(w: FeedWindow): string {
    return w === "book_early" ? "Showing what to book early ↓" : w === "coming_up" ? "Showing what's coming up ↓" : "Showing what's on today ↓";
  }

  // Fires once the newly-active window's own data is actually in (see the
  // window-change effect above, which arms `pendingToastRef`) — a fresh
  // switch always replaces any still-pending timer from a rapid previous
  // one, so only the latest toast is ever showing.
  useEffect(() => {
    if (!pendingToastRef.current || feed === null) return;
    pendingToastRef.current = false;
    const label = toastLabelFor(feedWindow);
    if (switchToastTimerRef.current) clearTimeout(switchToastTimerRef.current);
    // `setSwitchToast` deliberately isn't called synchronously in the effect
    // body — this effect is genuinely reacting to an external event (the new
    // window's data arriving) and also owns a real side effect (arming the
    // dismiss timer), not deriving render-time state, but the
    // react-hooks/set-state-in-effect rule can't tell the two apart
    // structurally; queueing it is the standard escape hatch.
    queueMicrotask(() => setSwitchToast({ label }));
    switchToastTimerRef.current = setTimeout(() => setSwitchToast(null), 2000);
  }, [feed, feedWindow]);

  // One plain-words line saying what the active tab shows, so the content
  // swap below it always comes with a reason.
  function windowSummary(): string {
    if (feedWindow === "book_early") return "Big dates worth booking before they sell out";
    if (feedWindow === "now") return "What's on today";
    // coming_up — COMING_UP_LOOKAHEAD_DAYS in app/api/feed/route.ts is 90 days.
    return "Everything coming up over the next few months";
  }

  // Tapping a tab to the right of the current one slides new content in from
  // the right (and vice versa) — mirrors how the sliding indicator itself
  // moves, so the two motions read as one gesture rather than two unrelated
  // animations.
  function handleWindowChange(next: FeedWindow) {
    if (next === feedWindow) return;
    const fromIndex = WINDOW_OPTIONS.findIndex((o) => o.value === feedWindow);
    const toIndex = WINDOW_OPTIONS.findIndex((o) => o.value === next);
    setSwitchDirection(toIndex >= fromIndex ? 1 : -1);
    track("tab_switched", { from: feedWindow, to: next });
    setWindow(next);
  }

  const windowSlideClass = switchDirection === 1 ? "feed-slide-in-right" : "feed-slide-in-left";

  return (
    <div className="relative flex flex-col gap-3 pb-6">
      {/* Ambient weather decoration — behind the header/hero region only
          (fixed height, not the whole page). `-z-10` (this `div` is now the
          positioned ancestor, via `relative` above) — drawn OVER the hero and
          deals strip (pointer-events-none, faint) because behind them it only
          showed in the thin gaps between opaque cards; the sticky header's
          own z-index still keeps it under the app bar.
          `weather` (not `weatherResult.data`) is already the resolved-or-null
          value handed to the header chip, so the two never disagree about
          what's currently showing. */}
      <AmbientWeather
        condition={weather?.condition ?? null}
        precipitationProbabilityMax={weather?.precipitationProbabilityMax}
        windSpeedMaxKmh={weather?.windSpeedMaxKmh}
        className="z-[5] h-[520px] lg:h-[360px]"
      />

      <AppHeader
        weather={weather}
        leading={
          // A picker with one choice is noise, so it's only offered once there's a second city.
          SUPPORTED_CITIES.length > 1 ? (
            <button
              type="button"
              onClick={() => setCityPickerOpen(true)}
              aria-label={`Change city (currently ${city.name})`}
              className="ml-1 flex shrink-0 items-center gap-1 rounded-full border border-hairline bg-surface-container-lowest px-2.5 py-0.5 transition-colors hover:bg-surface-container-low"
            >
              <Icon name="location_on" size={14} className="text-secondary" />
              <span className="text-label-sm font-bold tracking-tight text-secondary">{cityBadge(city)}</span>
            </button>
          ) : null
        }
      />

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
            Couldn&rsquo;t detect your location. Showing {city.name}.
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

      {/* Phone: one `flex-col gap-3` column, exactly as before — the `contents`
          main wrapper below generates no box, so its children are still direct
          flex items of this column. Desktop (lg+): a 12-col grid, main column
          (the wrapper turns into a real flex column) + a sticky right rail (the
          `<aside>` at the bottom, `hidden` on phones). The rail's three blocks
          (Today's deals, Make Fomo yours, Subscribe) are rendered a SECOND time
          there rather than moved: the phone copies stay in place with
          `lg:hidden`. None of the three has a fetch, mount effect or impression
          event (card_opened fires on click only; SubscribeCard tracks on submit
          only), and a `display:none` copy can't be clicked or submitted, so
          duplicating is analytics-neutral. */}
      <div className="flex flex-col gap-3 px-4 lg:mx-auto lg:grid lg:w-full lg:max-w-[1200px] lg:grid-cols-12 lg:items-start lg:gap-8 lg:px-8">
        <div className="contents lg:col-span-8 lg:flex lg:min-w-0 lg:flex-col lg:gap-3">
        {/* The page's h1 and one-line intro (visible, real text: it's what a
            search engine reads first). Part of the first HTML. Straight
            under it, the inline audience ask (Student / Under 26 / EH
            postcode): works signed out, and flips "You qualify" badges and
            ranking below the moment a chip is tapped. */}
        <div className="flex flex-col gap-2 px-1">
          <div className="flex flex-col gap-1">
            <h1 className="text-headline-md font-extrabold tracking-tight text-primary">
              Free and cheap things to do in Edinburgh
            </h1>
            <p className="text-body-md text-on-surface-variant">
              Student and local deals, plus what&rsquo;s on today, this weekend and coming up.
            </p>
          </div>
          <AudienceAsk className="-mx-1" />
        </div>

        {/* Window control — drives What's on, and on Book early the hero too
            (see `heroKind`). The plain-words line underneath restates the
            active tab's window so the abrupt content swap below it always
            comes with a reason, not just new cards. */}
        <div className="flex flex-col gap-1.5">
          <SegmentedControl value={feedWindow} options={WINDOW_OPTIONS} onChange={handleWindowChange} className="lg:max-w-md" />
          {/* Summary line and the /weekend link share one row, rather than
              a text line plus a full-width link bar stacked under it. */}
          <div className="flex items-center justify-between gap-3 px-1">
            <p className="min-w-0 text-label-md text-on-surface-variant">{windowSummary()}</p>
            <Link
              href="/weekend"
              className="flex h-9 shrink-0 items-center gap-1 rounded-full border border-hairline bg-surface-container-low px-3 text-label-md font-semibold text-primary transition-opacity hover:opacity-80"
            >
              This weekend
              <Icon name="chevron_right" size={18} />
            </Link>
          </div>
          {switchToast ? (
            <button
              type="button"
              onClick={() => {
                const el = feedWindow === "book_early" ? bookEarlySectionRef.current : whatsOnSectionRef.current;
                if (el && typeof window !== "undefined") {
                  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
                  el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
                }
                setSwitchToast(null);
              }}
              className="switch-toast self-start rounded-full bg-inverse-surface px-3 py-1.5 text-label-sm font-semibold text-inverse-on-surface shadow-level-2"
            >
              {switchToast.label}
            </button>
          ) : null}
        </div>

        {/* Top picks — the first content block on Today and Coming up: five
            ranked cards, each with its one-line reason, so the first screen
            shows the start of a short list rather than one big hero. The
            single hero card was dropped on these two tabs (it was the same
            ranking's number one, and often a pricey gig filling the whole
            first screen); Book early keeps its own hero below. Hidden
            entirely on Book early: that tab isn't a date window, and the
            route returns an empty `whatsOn` for it. `scroll-mt-20` keeps the
            sticky header from covering the section top when a window switch
            scrolls it into view. */}
        {feedWindow !== "book_early" ? (
          <div ref={whatsOnSectionRef} className="relative flex scroll-mt-20 flex-col gap-2 lg:scroll-mt-24">
            {/* Thin indeterminate progress bar — cached (possibly stale)
                content is already on screen below, so a background
                revalidation gets this instead of dimming/replacing what's
                already showing. */}
            {feedResult.data !== undefined && feedResult.isValidating ? (
              <div
                role="status"
                aria-label="Refreshing what's on"
                className="absolute -top-1 right-0 left-0 h-0.5 animate-pulse rounded-full bg-primary/60 motion-reduce:animate-none"
              />
            ) : null}

            {feed !== null && !feedError ? (
              <div className="flex items-center justify-between px-1">
                <h2 className="text-headline-sm font-extrabold tracking-tight text-on-surface">
                  Top picks
                  <span className="ml-1.5 font-semibold text-on-surface-variant">
                    · {WHATS_ON_WINDOW_LABEL[feedWindow]}
                  </span>
                </h2>
                <SeeAllLink href={`/whats-on?window=${feedWindow}`} total={whatsOnCards.length} />
              </div>
            ) : null}

            {feedError ? (
              // A real GET /api/feed failure with nothing cached to fall
              // back on — never rendered as the "Nothing lined up... try
              // another tab" empty copy below, which is reserved for a
              // genuinely empty (but successful) response.
              <ErrorState title="Couldn't load what's on" onRetry={retryFeed} />
            ) : feed === null ? (
              // Uncached window, first load ever for this session — 4 card
              // placeholders (not the full list's worth) held at the
              // previous window's rendered height so the segmented control
              // and the page below don't jump while this settles.
              <div
                className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4"
                style={{ minHeight: lastWhatsOnHeight }}
                role="status"
                aria-live="polite"
              >
                <span className="sr-only">Loading what&rsquo;s on…</span>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-container motion-reduce:animate-none" />
                ))}
              </div>
            ) : (
              // Cached or freshly-loaded data — rendered as soon as it's
              // available, which for a cache hit is the very same tick the
              // segmented control changes (no dim needed). `key={feedWindow}`
              // only remounts (and replays the slide-in) on an actual window
              // switch, not on a same-window background revalidation;
              // `windowSlideClass` picks the entrance direction to match
              // which side of the current tab was tapped.
              <div key={feedWindow} ref={whatsOnContentRef} className={`${windowSlideClass} flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4`}>
                {whatsOnCards.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 px-1 text-center lg:col-span-2">
                    <FomoSpot mood="meh" pose="shrug" className="h-16 w-16" />
                    <p className="text-body-sm text-on-surface-variant">{whatsOnEmptyMessage()}</p>
                  </div>
                ) : (
                  <>
                    {whatsOnTopPicks.map(({ card, reason }, i) => (
                      <FeedListCard key={cardKey(card)} card={card} surface="home_whats_on" position={i} reason={reason} />
                    ))}
                    <SeeAllButton
                      href={`/whats-on?window=${feedWindow}`}
                      total={whatsOnCards.length}
                      shown={SECTION_CAP}
                      className="lg:col-span-2"
                    />
                  </>
                )}
              </div>
            )}
          </div>
        ) : null}

        {/* Book early — its own tab (user feedback: Book early deserved more
            room than a capped section wedged under Coming up, and competed
            with What's on for the same tab's attention). Led by that tab's
            own hero (`heroKind === "book_early"`, HappeningHero's
            `variant="book_early"`); `hero: null` there means no hero at all.
            The API field itself stays window-independent — it's
            unconditionally returned by GET /api/feed because /book-early,
            /deals and /free all fetch window=now and depend on the full
            list — Home is just choosier about when it renders it. Same
            cap+"See all N" link convention as What's on above, out to
            /book-early — its own page, with its own timing/category/month
            filters and Ask Fomo button (see that page's own doc comment). */}
        {feedWindow === "book_early" ? (
          // The whole block only ever mounts on arrival at this tab (the
          // conditional above unmounts it entirely on the way out), so the
          // slide-in plays on mount here rather than needing its own
          // `key={feedWindow}` the way What's on's inner content does above.
          <div className={`${windowSlideClass} flex flex-col gap-3`}>
            {showHappeningHero && heroKind === "book_early" && feed?.hero ? (
              <FeedHero card={feed.hero} variant={heroKind} surface="book_early" />
            ) : null}
            <section ref={bookEarlySectionRef} className="flex scroll-mt-20 flex-col gap-2 lg:scroll-mt-24">
              <div className="flex items-center justify-between gap-2 px-1">
                <div className="flex items-center gap-2">
                  <Icon name="confirmation_number" size={20} className="text-accent" />
                  <h3 className="text-headline-sm font-extrabold tracking-tight text-on-surface">Book early</h3>
                </div>
                <SeeAllLink href="/book-early" total={bookEarlyAll.length} />
              </div>
              {feedError ? (
                <ErrorState title="Couldn't load Book early" onRetry={retryFeed} />
              ) : feed === null ? (
                <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4" role="status" aria-live="polite">
                  <span className="sr-only">Loading Book early…</span>
                  {[0, 1].map((i) => (
                    <div key={i} className="h-20 animate-pulse rounded-lg bg-surface-container motion-reduce:animate-none" />
                  ))}
                </div>
              ) : bookEarlyAll.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-1 text-center lg:col-span-2">
                  <FomoSpot mood="meh" pose="shrug" className="h-16 w-16" />
                  <p className="text-body-sm text-on-surface-variant">
                    Nothing worth booking early right now. Check back soon.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4">
                  {bookEarlyAll.slice(0, SECTION_CAP).map((card, i) => (
                    <BookEarlyCard
                      key={bookEarlyCardKey(card)}
                      card={card}
                      initialSubscribed={card.kind === "happening" && alertHappeningIds.has(card.happening.id)}
                      position={i}
                    />
                  ))}
                  <SeeAllButton href="/book-early" total={bookEarlyAll.length} shown={SECTION_CAP} className="lg:col-span-2" />
                </div>
              )}
            </section>
          </div>
        ) : null}

        {/* The weekly email, in the first scroll: a compact form right after
            the list (source "home_top"). The full card stays at the bottom.
            Hidden once this browser has subscribed or dismissed it, and on
            desktop, where the right rail already shows the full card. */}
        <SubscribeCard source="home_top" variant="compact" className="lg:hidden" />

        {/* Today's deals — independent of `feedWindow` (same as Book
            early/Free any time), so it stays put across every tab rather
            than disappearing on Coming up/Book early. Renders nothing of
            its own accord when the day's selection is too thin (see
            TodaysDealsStrip/todaysDeals). */}
        <TodaysDealsStrip deals={boostedTodaysDeals} surface="home_today_deals" className="lg:hidden" />

        {/* Slim, dismissible "Make Fomo yours" banner (task brief §2) —
            shown to anyone, signed in or out, who hasn't completed or
            skipped the card yet AND hasn't answered the audience ask at the
            top; hidden the instant either happens, whether that's from this
            banner, the inline chips, the first-save trigger
            (components/ui/SaveButton.tsx), or Profile's own Edit. */}
        {showPrefsBanner ? <MakeFomoYoursBanner onDismiss={() => void prefs.dismiss()} className="lg:hidden" /> : null}

        {/* "Out with the kids" — kid-friendly cards from today and this
            weekend, for a visitor who said "I've got kids" (Make Fomo yours).
            Hidden when fewer than KIDS_RAIL_MIN cards qualify. */}
        {kidsRail.length >= KIDS_RAIL_MIN ? <KidsRail cards={kidsRail} /> : null}

        {/* "Near you now" and "Any day" — moved out from under Top picks so
            the email form and today's deals sit in the first scroll. Near
            you now is Today only (distance means nothing for next week's
            list) and asks for location only on a tap
            (components/happenings/NearNowSection.tsx). */}
        {feedWindow !== "book_early" && feed !== null && !feedError ? (
          <div key={`extras-${feedWindow}`} className={`${windowSlideClass} flex flex-col gap-3`}>
            {feedWindow === "now" ? <NearNowSection feed={feed} /> : null}
            <AnyDaySection cards={boostedAnyDayCards} surface="home_any_day" desktopGrid />
          </div>
        ) : null}

        {/* Free any time — Today only. It used to render under every tab,
            which read as repetition once Coming up and Book early each had
            their own primary content to focus on; Today is
            the one tab short enough that "here's what's always free" still
            earns its place at the bottom rather than padding out the scroll. */}
        {feedWindow === "now" ? <FreeAnyTimeList items={freeAnyTime} /> : null}

        {/* Footer — Missing something? */}
        <div className="flex flex-col gap-3 rounded-lg bg-surface-container-low px-4 py-4">
          <div className="flex flex-col gap-1">
            <p className="text-label-md font-semibold text-on-surface">Missing something?</p>
            <p className="text-body-sm text-on-surface-variant">Know a deal we don&rsquo;t?</p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/tip"
              className="flex-1 flex items-center justify-center rounded-lg bg-primary px-3 py-2 text-label-md font-semibold text-on-primary transition-opacity hover:opacity-90"
            >
              Tip us off
            </Link>
            <div className="flex-1">
              <FeedbackLink className="w-full justify-center" />
            </div>
          </div>
        </div>

        <SubscribeCard source="home" className="lg:hidden" />
        </div>

        {/* Desktop right rail — sticky under the top bar; capped to the
            viewport (scrolls internally if the deals list + cards outgrow it).
            Second copies of the three blocks marked above. */}
        <aside
          aria-label="Deals and updates"
          className="hidden lg:sticky lg:top-[calc(var(--topbar-h)+24px)] lg:col-span-4 lg:-mx-2 lg:flex lg:max-h-[calc(100vh-var(--topbar-h)-48px)] lg:flex-col lg:gap-4 lg:overflow-y-auto lg:px-2 lg:pb-2 lg:[scrollbar-width:none] lg:[&::-webkit-scrollbar]:hidden"
        >
          <TodaysDealsStrip deals={boostedTodaysDeals} surface="home_today_deals" />
          {showPrefsBanner ? <MakeFomoYoursBanner onDismiss={() => void prefs.dismiss()} /> : null}
          <SubscribeCard source="home" />
        </aside>
      </div>
    </div>
  );
}
