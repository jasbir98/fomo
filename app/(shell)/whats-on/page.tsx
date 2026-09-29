"use client";

import Link from "next/link";
import { Suspense, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { FeedCardData, FeedResponse, FeedWindow } from "@/lib/happenings/feed-types";
import { weekendDates } from "@/lib/happenings/format";
import { isFreeCard } from "@/lib/happenings/price-label";
import { distinctCategoryFacets, matchesCategoryFilter, type CategoryFacetKey } from "@/lib/happenings/whats-on-filters";
import { useCachedJson } from "@/lib/http/clientCache";
import { useProgressiveReveal } from "@/lib/useProgressiveReveal";
import { Chip, ErrorState, FeedbackLink, PageHeader, SegmentedControl, StickyFilterBar } from "@/components/ui";
import { AnyDaySection, DateFilterRow, FeedListCard } from "@/components/happenings";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { cardOnDay, cardPillDate } from "@/components/happenings/DateFilterRow";
import { usePrefs } from "@/lib/personalise/usePrefs";
import { personalBoost, type BoostPrefs } from "@/lib/personalise/score";
import { useEffectiveWho } from "@/lib/personalise/useEffectiveWho";
import { track } from "@/lib/analytics/track";

/** Only these two windows are date windows at all — `book_early` is a
 *  separate tab with its own dedicated page (/book-early), never reachable
 *  from here. Mirrors app/(shell)/page.tsx's own WINDOW_OPTIONS gating. */
const WHATS_ON_WINDOWS: { value: Exclude<FeedWindow, "book_early">; label: string }[] = [
  { value: "now", label: "Today" },
  { value: "coming_up", label: "Coming up" },
];

/** Matches Home's own `FEED_STALE_MS` (app/(shell)/page.tsx) — duplicated as a plain number rather than imported across route boundaries. */
const FEED_STALE_MS = 60_000;

function isWhatsOnWindow(value: string | null): value is Exclude<FeedWindow, "book_early"> {
  return value === "now" || value === "coming_up";
}

function cardKey(card: FeedCardData): string {
  if (card.kind === "happening") return `happening-${card.happening.id}`;
  if (card.kind === "series") return `series-${card.key}`;
  if (card.kind === "recurring") return `recurring-${card.key}`;
  return `event-${card.event.id}`;
}

// Throws on a non-2xx status, rather than swallowing every failure to the
// same `null` a genuinely-empty bucket would also produce. Fetches the FULL
// GET /api/feed response — not just `whatsOn` — and caches it under
// `feed:${window}`, the exact key app/(shell)/page.tsx's Home page uses for
// the same window: arriving here via Home's "See all N" link (which is the
// only way in) means this page's first paint is very often an instant cache
// hit off whatever Home already loaded, not a fresh fetch.
async function fetchFeed(window: Exclude<FeedWindow, "book_early">, signal?: AbortSignal): Promise<FeedResponse> {
  const params = new URLSearchParams({ window });
  const res = await fetch(`/api/feed?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`GET /api/feed ${res.status}`);
  return (await res.json()) as FeedResponse;
}

/**
 * What's on — the dedicated destination the old in-place "Show all N"
 * expander on Home used to fake (task brief: "it needs to open a new kind of
 * window and show all the things there rather than showing them in the same
 * place... the filters should be inside that page"). Reached from Home via
 * "See all N" (app/(shell)/page.tsx), which passes the tab the caller was
 * already on through `?window=`; this page owns switching between the two
 * date windows itself from then on (own SegmentedControl, own URL, own
 * fetch) rather than only ever showing the window Home linked to.
 *
 * Filters (date, category) are purely client-side over the one window's
 * already-fetched card list — same "no refetch on a chip tap" principle as
 * /book-early, /deals and /free — only the window switch itself refetches
 * (GET /api/feed's `whatsOn` is the one field that's actually window-driven;
 * see lib/happenings/feed-types.ts's own doc comment).
 */
function WhatsOnPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const windowParam = searchParams.get("window");
  const initialWindow: Exclude<FeedWindow, "book_early"> = isWhatsOnWindow(windowParam) ? windowParam : "now";
  const [feedWindow, setFeedWindowState] = useState<Exclude<FeedWindow, "book_early">>(initialWindow);
  const [dateFilter, setDateFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFacetKey | null>(null);
  // Freshness badge / price label task (PM decision 2026-09-26): a "Free
  // only" toggle, state kept in the URL (`?free=1`, alongside the existing
  // `?window=`) so an IG link like askfomo.com/whats-on?free=1 lands
  // pre-filtered — same URL-as-state principle as `feedWindow` above.
  const [freeOnly, setFreeOnlyState] = useState(searchParams.get("free") === "1");
  // "For you" (task brief §3) — unlike every other filter on this page, this
  // is purely a display sort, never applied to `/whats-on`'s own date
  // ordering by default (the brief: "Not on /whats-on full list date
  // ordering (leave chronological)... DO add a 'For you' chip there that
  // sorts by boost"), so it's a plain client toggle with no URL state.
  const [forYou, setForYouState] = useState(false);
  function setForYou(next: boolean) {
    setForYouState(next);
    track("filter_used", { filter: "for_you", value: next, page: "whats_on" });
  }
  function selectDateFilter(next: string) {
    setDateFilter(next);
    track("filter_used", { filter: "date", value: next, page: "whats_on" });
  }
  function selectCategoryFilter(next: CategoryFacetKey | null) {
    setCategoryFilter(next);
    track("filter_used", { filter: "category", value: next, page: "whats_on" });
  }
  const who = useEffectiveWho();
  const prefs = usePrefs();
  const boostPrefs: BoostPrefs = useMemo(
    () => ({ interests: prefs.interests, budget: prefs.budget, who }),
    [prefs.interests, prefs.budget, who]
  );

  function setFreeOnly(next: boolean) {
    setFreeOnlyState(next);
    track("filter_used", { filter: "free_only", value: next, page: "whats_on" });
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("free", "1");
    else params.delete("free");
    router.replace(`/whats-on?${params.toString()}`, { scroll: false });
  }

  // Both windows, always — not just the active tab's. `now`/`coming_up` are
  // disjoint by construction (occurrenceWindowRange in app/api/feed/route.ts
  // starts `coming_up` the day after `now` ends (today vs tomorrow onwards)), so "This weekend" straddles
  // both windows on a Fri/Sat/Sun visit (Fri: only Sun matches; Sat/Sun: only
  // today's own window has today's own weekend day) — same fix as
  // app/(shell)/weekend/page.tsx, whose merge-and-dedupe this mirrors. Same
  // cache keys Home/`fetchFeed` already use, so whichever window the visitor
  // arrived on (via `?window=`) is very often already warm.
  const nowFeed = useCachedJson<FeedResponse>("feed:now", (signal) => fetchFeed("now", signal), {
    staleMs: FEED_STALE_MS,
  });
  const comingUpFeed = useCachedJson<FeedResponse>("feed:coming_up", (signal) => fetchFeed("coming_up", signal), {
    staleMs: FEED_STALE_MS,
  });
  // `error` only means "nothing cached for this window and the last attempt
  // failed", never a background revalidation hiccup with a cached window
  // still showing.
  const feedResult = feedWindow === "now" ? nowFeed : comingUpFeed;
  const cards = useMemo(
    () => (feedResult.data ? (feedResult.data.whatsOn[0]?.cards ?? []) : null),
    [feedResult.data]
  );
  // "Any day" (lib/happenings/everyday.ts): the active window's everyday cards,
  // kept out of `cards` so the date chips/list never see them. Independent of
  // the date filter (a specific day chip still shows them — they're on every
  // day), but subject to the category / Free only / For you controls.
  const anyDayAll = useMemo(() => feedResult.data?.anyDay?.cards ?? [], [feedResult.data]);
  const error = feedResult.error != null && feedResult.data === undefined;
  // Same "nothing cached and the last attempt failed" contract as `error`
  // above, but over both windows — what "This weekend" actually needs.
  const weekendError =
    (nowFeed.error != null && nowFeed.data === undefined) ||
    (comingUpFeed.error != null && comingUpFeed.data === undefined);

  function setFeedWindow(next: Exclude<FeedWindow, "book_early">) {
    setFeedWindowState(next);
    setDateFilter("all");
    setCategoryFilter(null);
    const params = new URLSearchParams({ window: next });
    if (freeOnly) params.set("free", "1");
    router.replace(`/whats-on?${params.toString()}`, { scroll: false });
  }

  const dates = useMemo(() => {
    if (!cards) return [];
    const set = new Set<string>();
    for (const card of cards) {
      const day = cardPillDate(card);
      if (day) set.add(day);
    }
    return Array.from(set).sort();
  }, [cards]);

  const { saturday: weekendSaturday, sunday: weekendSunday } = weekendDates();

  // "This weekend" merges BOTH windows (see the `nowFeed`/`comingUpFeed`
  // doc comment above) — unlike "All dates" and the specific-date pills,
  // which stay scoped to the active window's own `cards` because `dates`
  // (the pills themselves) is derived from that same list, so there's no
  // window to straddle there. `null` while either window is still loading;
  // deduped by `cardKey` in case a card were ever eligible in both (it
  // shouldn't be, windows are disjoint, but a merge should never double-list
  // one regardless).
  const weekendCards = useMemo(() => {
    if (!nowFeed.data || !comingUpFeed.data) return null;
    const seen = new Set<string>();
    const out: FeedCardData[] = [];
    for (const card of [...(nowFeed.data.whatsOn[0]?.cards ?? []), ...(comingUpFeed.data.whatsOn[0]?.cards ?? [])]) {
      const key = cardKey(card);
      if (seen.has(key) || !(cardOnDay(card, weekendSaturday) || cardOnDay(card, weekendSunday))) continue;
      seen.add(key);
      out.push(card);
    }
    return out;
  }, [nowFeed.data, comingUpFeed.data, weekendSaturday, weekendSunday]);

  const dateFilteredCards = useMemo(() => {
    if (dateFilter === "weekend") return weekendCards ?? [];
    if (!cards) return [];
    if (dateFilter === "all") return cards;
    return cards.filter((c) => cardOnDay(c, dateFilter));
  }, [cards, dateFilter, weekendCards]);

  // "This weekend" is ready once its own merged list resolves; every other
  // filter rides the active window's own `cards`/`error` as before.
  const listReady = dateFilter === "weekend" ? weekendCards !== null : cards !== null;
  const listError = dateFilter === "weekend" ? weekendError : error;

  const categoryOptions = useMemo(
    () => distinctCategoryFacets([...dateFilteredCards, ...anyDayAll]),
    [dateFilteredCards, anyDayAll]
  );

  const filteredCards = useMemo(
    () =>
      dateFilteredCards.filter(
        (c) => matchesCategoryFilter(c, categoryFilter) && (!freeOnly || isFreeCard(c))
      ),
    [dateFilteredCards, categoryFilter, freeOnly]
  );

  const filteredAnyDay = useMemo(
    () => anyDayAll.filter((c) => matchesCategoryFilter(c, categoryFilter) && (!freeOnly || isFreeCard(c))),
    [anyDayAll, categoryFilter, freeOnly]
  );

  // "For you" (task brief §3) — a genuine re-sort by `personalBoost`, not
  // the gentle few-positions nudge lib/personalise/score.ts's
  // `reorderWithBoost` gives Home/Deals: this chip's whole point is "show me
  // my kind of thing first", so it's a plain stable sort, descending by
  // score, highest first; ties keep their original (chronological) order.
  // Off, `visibleCards` is exactly `filteredCards` — untouched chronological
  // order, per the brief's "leave chronological" for the page's default.
  const visibleCards = useMemo(() => {
    if (!forYou) return filteredCards;
    return filteredCards
      .map((card, index) => ({ card, index, score: personalBoost(card, boostPrefs) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.card);
  }, [filteredCards, forYou, boostPrefs]);

  // Same "For you" sort, applied within the Any day section on its own.
  const visibleAnyDay = useMemo(() => {
    if (!forYou) return filteredAnyDay;
    return filteredAnyDay
      .map((card, index) => ({ card, index, score: personalBoost(card, boostPrefs) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.card);
  }, [filteredAnyDay, forYou, boostPrefs]);

  // Count = dated list + Any day (matches Home's tab badge).
  const visibleTotal = visibleCards.length + visibleAnyDay.length;

  // Renders in chunks of 20 rather than mounting the whole (potentially
  // large, uncapped — see the pagination audit in the caller's report) list
  // at once.
  const revealSentinelRef = useRef<HTMLDivElement>(null);
  const revealCount = useProgressiveReveal(visibleCards.length, null, revealSentinelRef, {
    vertical: true,
    step: 20,
  });

  function emptyMessage(): string {
    if (listReady && visibleTotal === 0 && (dateFilter === "weekend" ? (weekendCards?.length ?? 0) : (cards?.length ?? 0)) + anyDayAll.length > 0) {
      if (dateFilter !== "all" && dateFilteredCards.length === 0 && anyDayAll.length === 0) {
        return dateFilter === "weekend" ? "Nothing this weekend — try another date." : "Nothing on that day — try another date.";
      }
      if (freeOnly) return "Nothing free matches — turn off Free only.";
      return "Nothing matches — try a different filter.";
    }
    if (dateFilter === "weekend") return "Nothing lined up for this weekend yet — check back soon.";
    return feedWindow === "now"
      ? "Nothing lined up for today yet — try Coming up."
      : "Nothing lined up yet — check back soon.";
  }

  return (
    <div className="flex flex-col gap-5 pb-8">
      <PageHeader title="What's on" showBack />

      <div className="flex flex-col gap-4 px-4">
        <StickyFilterBar className="-mx-4 px-4">
          <div className="flex flex-col gap-3">
            <SegmentedControl value={feedWindow} options={WHATS_ON_WINDOWS} onChange={setFeedWindow} />

            {dates.length >= 2 ? (
              <DateFilterRow dates={dates} selected={dateFilter} onSelect={selectDateFilter} />
            ) : null}

            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [&::-webkit-scrollbar]:hidden">
              <Chip
                label="Free only"
                leadingIcon="check_circle"
                selected={freeOnly}
                onClick={() => setFreeOnly(!freeOnly)}
              />
              <Chip
                label="For you"
                leadingIcon="auto_awesome"
                selected={forYou}
                aria-pressed={forYou}
                onClick={() => setForYou(!forYou)}
              />
              {categoryOptions.length > 1 ? (
                <>
                  <Chip label="All" selected={categoryFilter === null} onClick={() => selectCategoryFilter(null)} />
                  {categoryOptions.map((facet) => (
                    <Chip
                      key={facet.key}
                      label={facet.label}
                      leadingIcon={facet.icon}
                      selected={categoryFilter === facet.key}
                      onClick={() => selectCategoryFilter(facet.key)}
                    />
                  ))}
                </>
              ) : null}
            </div>
          </div>
        </StickyFilterBar>

        <div className="flex items-center justify-between px-1">
          <h2 className="text-headline-sm font-extrabold tracking-tight text-on-surface">
            {feedWindow === "now" ? "Today" : "Coming up"}
          </h2>
          {listReady && !listError ? (
            <span className="rounded-full border border-hairline-strong bg-surface-container px-2.5 py-0.5 text-label-sm font-extrabold text-primary">
              {visibleTotal}
            </span>
          ) : null}
        </div>

        {listError ? (
          <ErrorState
            title="Couldn't load what's on"
            onRetry={() => {
              feedResult.revalidate();
              if (dateFilter === "weekend") {
                nowFeed.revalidate();
                comingUpFeed.revalidate();
              }
            }}
          />
        ) : !listReady ? (
          <div className="flex flex-col gap-3 pt-2" role="status" aria-live="polite">
            <span className="sr-only">Loading what&rsquo;s on…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-container" />
            ))}
          </div>
        ) : visibleTotal === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong p-8 text-center">
            <FomoSpot
              mood={(dateFilter === "weekend" ? (weekendCards?.length ?? 0) : (cards?.length ?? 0)) + anyDayAll.length > 0 ? "hmm" : "meh"}
              pose="shrug"
              className="h-20 w-20"
            />
            <p className="text-body-md text-on-surface-variant">{emptyMessage()}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 pt-1">
            {visibleCards.slice(0, revealCount).map((card, i) => (
              <FeedListCard key={cardKey(card)} card={card} surface="whats_on" position={i} />
            ))}
            {revealCount < visibleCards.length ? <div ref={revealSentinelRef} className="h-1" /> : null}
            {visibleCards.length === 0 ? (
              <p className="px-1 text-body-sm text-on-surface-variant">Nothing dated matches — just the always-on things below.</p>
            ) : null}
            <AnyDaySection cards={visibleAnyDay} surface="whats_on_any_day" />
          </div>
        )}
      {/* Footer */}
      <div className="flex flex-col gap-3 border-t border-outline-variant px-4 pt-6 pb-4">
        <div className="flex flex-col gap-1">
          <p className="text-label-md font-semibold text-on-surface">Help us improve</p>
          <p className="text-body-sm text-on-surface-variant">Missing something? Have feedback?</p>
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

      </div>
    </div>
  );
}

export default function WhatsOnPage() {
  return (
    <Suspense fallback={null}>
      <WhatsOnPageInner />
    </Suspense>
  );
}
