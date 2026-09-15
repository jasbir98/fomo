"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { FeedCardData, FeedResponse, FeedWindow } from "@/lib/happenings/feed-types";
import { weekendDates } from "@/lib/happenings/format";
import { distinctCategoryFacets, matchesCategoryFilter, type CategoryFacetKey } from "@/lib/happenings/whats-on-filters";
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

function isWhatsOnWindow(value: string | null): value is Exclude<FeedWindow, "book_early"> {
  return value === "now" || value === "coming_up";
}

function cardKey(card: FeedCardData): string {
  if (card.kind === "happening") return `happening-${card.happening.id}`;
  if (card.kind === "series") return `series-${card.key}`;
  return `event-${card.event.id}`;
}

// Throws on abort (the caller distinguishes that — a superseded request, not
// a failure) or a non-2xx status, rather than swallowing every failure to
// the same `null` a genuinely-empty bucket would also produce.
async function fetchWhatsOn(
  window: Exclude<FeedWindow, "book_early">,
  signal?: AbortSignal
): Promise<FeedCardData[]> {
  const params = new URLSearchParams({ window });
  const res = await fetch(`/api/feed?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`GET /api/feed ${res.status}`);
  const json = (await res.json()) as FeedResponse;
  return json.whatsOn[0]?.cards ?? [];
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
  const [cards, setCards] = useState<FeedCardData[] | null>(null);
  const [error, setError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [dateFilter, setDateFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFacetKey | null>(null);

  function setFeedWindow(next: Exclude<FeedWindow, "book_early">) {
    setFeedWindowState(next);
    setDateFilter("all");
    setCategoryFilter(null);
    router.replace(`/whats-on?window=${next}`, { scroll: false });
  }

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      setCards(null);
      setError(false);
      try {
        const json = await fetchWhatsOn(feedWindow, controller.signal);
        if (!controller.signal.aborted) setCards(json);
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        console.error("[whats-on] /api/feed fetch failed", err);
        setError(true);
      }
    })();
    return () => controller.abort();
  }, [feedWindow, reloadTick]);

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
    () => dateFilteredCards.filter((c) => matchesCategoryFilter(c, categoryFilter)),
    [dateFilteredCards, categoryFilter]
  );

  function emptyMessage(): string {
    if (cards && cards.length > 0 && visibleCards.length === 0) {
      return dateFilter !== "all" && dateFilteredCards.length === 0
        ? "Nothing on that day — try another date."
        : "Nothing matches — try a different filter.";
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

            {categoryOptions.length > 1 ? (
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [&::-webkit-scrollbar]:hidden">
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
              </div>
            ) : null}
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
          <ErrorState title="Couldn't load what's on" onRetry={() => setReloadTick((t) => t + 1)} />
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
            {visibleCards.map((card) => (
              <FeedListCard key={cardKey(card)} card={card} />
            ))}
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
