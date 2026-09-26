"use client";

import { Suspense, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { FeedCardData, FeedResponse, FeedWindow } from "@/lib/happenings/feed-types";
import { weekendDates } from "@/lib/happenings/format";
import { isFreeCard } from "@/lib/happenings/price-label";
import { distinctCategoryFacets, matchesCategoryFilter, type CategoryFacetKey } from "@/lib/happenings/whats-on-filters";
import { useCachedJson } from "@/lib/http/clientCache";
import { useProgressiveReveal } from "@/lib/useProgressiveReveal";
import { Chip, ErrorState, PageHeader, SegmentedControl, StickyFilterBar } from "@/components/ui";
import { DateFilterRow, FeedListCard } from "@/components/happenings";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { cardOnDay, cardPillDate } from "@/components/happenings/DateFilterRow";

/** Only these two windows are date windows at all — `book_early` is a
 *  separate tab with its own dedicated page (/book-early), never reachable
 *  from here. Mirrors app/(shell)/page.tsx's own WINDOW_OPTIONS gating. */
const WHATS_ON_WINDOWS: { value: Exclude<FeedWindow, "book_early">; label: string }[] = [
  { value: "now", label: "Today & tomorrow" },
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

  function setFreeOnly(next: boolean) {
    setFreeOnlyState(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("free", "1");
    else params.delete("free");
    router.replace(`/whats-on?${params.toString()}`, { scroll: false });
  }

  // Cached (and shared with Home, see fetchFeed's doc comment) per window —
  // `error` only means "nothing cached for this window and the last attempt
  // failed", never a background revalidation hiccup with a cached window
  // still showing.
  const feedResult = useCachedJson<FeedResponse>(`feed:${feedWindow}`, (signal) => fetchFeed(feedWindow, signal), {
    staleMs: FEED_STALE_MS,
  });
  const cards = useMemo(
    () => (feedResult.data ? (feedResult.data.whatsOn[0]?.cards ?? []) : null),
    [feedResult.data]
  );
  const error = feedResult.error != null && feedResult.data === undefined;

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

  const dateFilteredCards = useMemo(() => {
    if (!cards) return [];
    if (dateFilter === "all") return cards;
    if (dateFilter === "weekend") {
      return cards.filter((c) => cardOnDay(c, weekendSaturday) || cardOnDay(c, weekendSunday));
    }
    return cards.filter((c) => cardOnDay(c, dateFilter));
  }, [cards, dateFilter, weekendSaturday, weekendSunday]);

  const categoryOptions = useMemo(() => distinctCategoryFacets(dateFilteredCards), [dateFilteredCards]);

  const visibleCards = useMemo(
    () =>
      dateFilteredCards.filter(
        (c) => matchesCategoryFilter(c, categoryFilter) && (!freeOnly || isFreeCard(c))
      ),
    [dateFilteredCards, categoryFilter, freeOnly]
  );

  // Renders in chunks of 20 rather than mounting the whole (potentially
  // large, uncapped — see the pagination audit in the caller's report) list
  // at once.
  const revealSentinelRef = useRef<HTMLDivElement>(null);
  const revealCount = useProgressiveReveal(visibleCards.length, null, revealSentinelRef, {
    vertical: true,
    step: 20,
  });

  function emptyMessage(): string {
    if (cards && cards.length > 0 && visibleCards.length === 0) {
      if (dateFilter !== "all" && dateFilteredCards.length === 0) return "Nothing on that day — try another date.";
      if (freeOnly) return "Nothing free matches — turn off Free only.";
      return "Nothing matches — try a different filter.";
    }
    return feedWindow === "now"
      ? "Nothing lined up for today & tomorrow yet — try Coming up."
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
              <DateFilterRow dates={dates} selected={dateFilter} onSelect={setDateFilter} />
            ) : null}

            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [&::-webkit-scrollbar]:hidden">
              <Chip
                label="Free only"
                leadingIcon="check_circle"
                selected={freeOnly}
                onClick={() => setFreeOnly(!freeOnly)}
              />
              {categoryOptions.length > 1 ? (
                <>
                  <Chip label="All" selected={categoryFilter === null} onClick={() => setCategoryFilter(null)} />
                  {categoryOptions.map((facet) => (
                    <Chip
                      key={facet.key}
                      label={facet.label}
                      leadingIcon={facet.icon}
                      selected={categoryFilter === facet.key}
                      onClick={() => setCategoryFilter(facet.key)}
                    />
                  ))}
                </>
              ) : null}
            </div>
          </div>
        </StickyFilterBar>

        <div className="flex items-center justify-between px-1">
          <h2 className="text-headline-sm font-extrabold tracking-tight text-on-surface">
            {feedWindow === "now" ? "Today & tomorrow" : "Coming up"}
          </h2>
          {cards !== null && !error ? (
            <span className="rounded-full border border-hairline-strong bg-surface-container px-2.5 py-0.5 text-label-sm font-extrabold text-primary">
              {visibleCards.length}
            </span>
          ) : null}
        </div>

        {error ? (
          <ErrorState title="Couldn't load what's on" onRetry={() => feedResult.revalidate()} />
        ) : cards === null ? (
          <div className="flex flex-col gap-3 pt-2" role="status" aria-live="polite">
            <span className="sr-only">Loading what&rsquo;s on…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-container" />
            ))}
          </div>
        ) : visibleCards.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong p-8 text-center">
            <FomoSpot mood={cards.length > 0 ? "hmm" : "meh"} pose="shrug" className="h-20 w-20" />
            <p className="text-body-md text-on-surface-variant">{emptyMessage()}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 pt-1">
            {visibleCards.slice(0, revealCount).map((card) => (
              <FeedListCard key={cardKey(card)} card={card} />
            ))}
            {revealCount < visibleCards.length ? <div ref={revealSentinelRef} className="h-1" /> : null}
          </div>
        )}
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
