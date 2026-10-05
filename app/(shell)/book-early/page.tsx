"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { FeedResponse } from "@/lib/happenings/feed-types";
import { NOTIFY_ME_ENABLED, type BookEarlyCardData } from "@/lib/happenings/book-early";
import {
  matchesBookEarlyFilters,
  monthForCard,
  type BookEarlyTiming,
  type MonthFacet,
} from "@/lib/happenings/book-early-filters";
import { CATEGORY_ORDER } from "@/lib/happenings/category-style";
import type { HappeningCategory } from "@/lib/happenings/types";
import { useCachedJson } from "@/lib/http/clientCache";
import { useProgressiveReveal } from "@/lib/useProgressiveReveal";
import { ErrorState, Icon, PageHeader, StickyFilterBar } from "@/components/ui";
import { BookEarlyCard, BookEarlyFilters } from "@/components/happenings";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { track } from "@/lib/analytics/track";

function bookEarlyCardKey(card: BookEarlyCardData): string {
  return card.kind === "happening" ? `happening-${card.happening.id}` : `event-${card.event.id}`;
}

/** Ask Fomo deep-link — plain `?q=` prefill (see app/(shell)/fomo/page.tsx's
 *  own doc comment on that param), not the `seed` mechanism, which pins a
 *  specific subject card and needs a type/id/name this page-level button has
 *  none of. */
const ASK_FOMO_HREF = `/fomo?q=${encodeURIComponent("What's worth booking early in Edinburgh?")}`;

/** Matches Home's feed/alerts staleness (app/(shell)/page.tsx) — duplicated as plain numbers rather than imported across route boundaries. Same key names as Home's own `useCachedJson` calls ("book-early" mirrors Home's `feed:book_early`'s *data*, not its cache slot — see the doc comment below — but "alerts" is the literal same key, so the two pages share one warm cache entry for it.) */
const BOOK_EARLY_STALE_MS = 60_000;
const ALERTS_STALE_MS = 5 * 60_000;

/** GET /api/feed's `bookEarly` is already the FULL ranked list (Home only
 *  ever slices its first few) — this page reuses the same response rather
 *  than standing up a parallel /api/book-early route that would duplicate
 *  app/api/feed/route.ts's `buildBookEarly`. Same principle as
 *  app/(shell)/deals/page.tsx. `window` doesn't affect
 *  `bookEarly` (it's independent of the request's window — see that route's
 *  own doc comment), so it's fixed here. Returns the full `FeedResponse`
 *  and is cached under Home's own `feed:now` key — same URL, same shape —
 *  so this page shares one cache entry with Home, What's on, Deals and Free.
 *
 *  Throws (rather than swallowing to `null`) on a network error or non-2xx
 *  status, so `useCachedJson` can tell failure from empty. */
async function fetchFeedNow(signal?: AbortSignal): Promise<FeedResponse> {
  const res = await fetch("/api/feed?window=now", { signal });
  if (!res.ok) throw new Error(`GET /api/feed ${res.status}`);
  return (await res.json()) as FeedResponse;
}

async function fetchAlertIds(signal?: AbortSignal): Promise<string[]> {
  const res = await fetch("/api/alerts", { signal });
  const json = (await res.json()) as { happeningIds?: string[] };
  return json.happeningIds ?? [];
}

/**
 * Book early — its own full page (moved out of Home's in-place "Show all N"
 * expander per the task brief: Book early and Free Any Time each get a
 * dedicated destination with their own filters and an Ask Fomo entry point,
 * reached from Home via a "See all" link instead of growing Home in place).
 * Same ranking/labels as the Home section (lib/happenings/book-early.ts) —
 * this page adds three client-side filters (timing / category / month, see
 * lib/happenings/book-early-filters.ts) over the identical full list.
 */
export default function BookEarlyPage() {
  // `error` only means "nothing cached and the last attempt failed".
  // The FULL feed under Home's own `feed:now` key (same URL) — shared with
  // Home, What's on, Deals and Free, so moving between them doesn't re-fetch.
  const cardsResult = useCachedJson<FeedResponse>("feed:now", fetchFeedNow, {
    staleMs: BOOK_EARLY_STALE_MS,
  });
  const cards: BookEarlyCardData[] | null = cardsResult.data?.bookEarly ?? null;
  const error = cardsResult.error != null && cards === null;

  // Same "Notify me" membership read as Home (app/(shell)/page.tsx), and the
  // same "alerts" cache key — landing here after Home already warmed it (or
  // vice versa) means no second network round trip. A BookEarlyCard needs
  // this up front or the button flashes "Notify me" before resetting to
  // "Notified" a moment later.
  const alertsResult = useCachedJson<string[]>(NOTIFY_ME_ENABLED ? "alerts" : null, fetchAlertIds, {
    staleMs: ALERTS_STALE_MS,
  });
  const alertHappeningIds = useMemo(() => new Set(alertsResult.data ?? []), [alertsResult.data]);

  const [timing, setTiming] = useState<BookEarlyTiming | null>(null);
  const [category, setCategory] = useState<HappeningCategory | null>(null);
  const [month, setMonth] = useState<string | null>(null);

  function handleTimingChange(value: BookEarlyTiming | null) {
    setTiming(value);
    track("filter_used", { filter: "timing", value, page: "book_early" });
  }
  function handleCategoryChange(value: HappeningCategory | null) {
    setCategory(value);
    track("filter_used", { filter: "category", value, page: "book_early" });
  }
  function handleMonthChange(value: string | null) {
    setMonth(value);
    track("filter_used", { filter: "month", value, page: "book_early" });
  }

  const categoryOptions = useMemo(() => {
    if (!cards) return [];
    const present = new Set<HappeningCategory>();
    for (const c of cards) {
      if (c.kind === "happening" && c.happening.category) present.add(c.happening.category);
    }
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }, [cards]);

  const monthOptions = useMemo(() => {
    if (!cards) return [];
    const seen = new Map<string, MonthFacet>();
    for (const c of cards) {
      const facet = monthForCard(c);
      if (!seen.has(facet.key)) seen.set(facet.key, facet);
    }
    return Array.from(seen.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [cards]);

  const filteredCards = useMemo(() => {
    if (!cards) return [];
    return cards.filter((c) => matchesBookEarlyFilters(c, timing, category, month));
  }, [cards, timing, category, month]);

  // Renders in chunks of 20 rather than mounting the whole (potentially
  // large) ranked list at once — no pagination on this endpoint (see the
  // pagination audit in the caller's report), so this is where the actual
  // render cost gets capped instead.
  const revealSentinelRef = useRef<HTMLDivElement>(null);
  const visibleCount = useProgressiveReveal(filteredCards.length, null, revealSentinelRef, {
    vertical: true,
    step: 20,
  });

  return (
    <div className="flex flex-col pb-6">
      <PageHeader title="Book early" showBack />

      {/* Desktop: filters + Ask Fomo in a sticky left rail, results in a 2-col grid. Below
          lg the aside/main wrappers are `display: contents`, so the mobile flow (intro,
          sticky filter bar, list) is exactly the flat sibling list it always was. */}
      <div className="flex flex-col gap-3 px-4 pt-1 lg:mx-auto lg:grid lg:w-full lg:max-w-[1200px] lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start lg:gap-x-8 lg:px-8 lg:pt-6">
        <aside className="contents lg:col-start-1 lg:row-start-1 lg:flex lg:max-h-[calc(100dvh-var(--topbar-h)-48px)] lg:flex-col lg:gap-4 lg:overflow-y-auto lg:sticky lg:top-[calc(var(--topbar-h)+24px)] lg:-mx-1 lg:px-1">
          <p className="text-body-md text-on-surface-variant">
            Big dates worth booking before they sell out
          </p>

          <StickyFilterBar className="-mx-4 px-4 lg:hidden">
            <div className="flex items-start justify-between gap-2">
              <span className="px-1 pt-1.5 text-label-lg font-semibold text-on-surface-variant">
                {cards ? `${filteredCards.length} ${filteredCards.length === 1 ? "date" : "dates"}` : ""}
              </span>
              <div className="flex items-start gap-2">
                <BookEarlyFilters
                timing={timing}
                category={category}
                month={month}
                categoryOptions={categoryOptions}
                monthOptions={monthOptions}
                onTimingChange={handleTimingChange}
                onCategoryChange={handleCategoryChange}
                onMonthChange={handleMonthChange}
                resultCount={cards === null ? null : filteredCards.length}
              />
                <Link
                  href={ASK_FOMO_HREF}
                  className="flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-surface px-3.5 py-1.5 text-label-sm font-semibold text-primary shadow-sm transition-colors hover:bg-surface-container"
                >
                  <Icon name="chat" size={16} />
                  Ask Fomo
                </Link>
              </div>
            </div>
          </StickyFilterBar>

          {/* Desktop-only second render of the (fully controlled) filters: its inline panel. */}
          <div className="hidden rounded-2xl bg-surface-container-lowest p-4 shadow-level-1 lg:block">
            <BookEarlyFilters
                timing={timing}
                category={category}
                month={month}
                categoryOptions={categoryOptions}
                monthOptions={monthOptions}
                onTimingChange={handleTimingChange}
                onCategoryChange={handleCategoryChange}
                onMonthChange={handleMonthChange}
                resultCount={cards === null ? null : filteredCards.length}
              />
          </div>
          <Link
            href={ASK_FOMO_HREF}
            className="hidden items-center justify-center gap-1.5 rounded-full border border-primary/30 bg-surface px-3.5 py-2 text-label-md font-semibold text-primary shadow-sm transition-colors hover:bg-surface-container lg:flex"
          >
            <Icon name="chat" size={16} />
            Ask Fomo
          </Link>
        </aside>

        <div className="contents lg:col-start-2 lg:row-start-1 lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
          {error ? (
            <ErrorState title="Couldn't load Book early" onRetry={() => cardsResult.revalidate()} />
          ) : cards === null ? (
            <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4 2xl:grid-cols-3" role="status" aria-live="polite">
              <span className="sr-only">Loading Book early…</span>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className={`h-24 animate-pulse rounded-lg bg-surface-container ${i === 3 ? "hidden lg:block" : ""}`} />
              ))}
            </div>
          ) : cards.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong p-8 text-center">
              <FomoSpot mood="meh" pose="shrug" className="h-20 w-20" />
              <p className="text-body-md text-on-surface-variant">Nothing to book early right now. Check back soon.</p>
            </div>
          ) : filteredCards.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong py-6 text-center">
              <FomoSpot mood="hmm" pose="shrug" className="h-16 w-16" />
              <p className="text-body-sm text-on-surface-variant">Nothing matches. Clear filters</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 2xl:grid-cols-3">
              {filteredCards.slice(0, visibleCount).map((card, i) => (
                <BookEarlyCard
                  key={bookEarlyCardKey(card)}
                  card={card}
                  initialSubscribed={card.kind === "happening" && alertHappeningIds.has(card.happening.id)}
                  position={i}
                />
              ))}
              {visibleCount < filteredCards.length ? <div ref={revealSentinelRef} className="h-1 lg:col-span-full" /> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
