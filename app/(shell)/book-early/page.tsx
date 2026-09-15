"use client";

import { useEffect, useMemo, useState } from "react";
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
import { ErrorState, Icon, PageHeader, StickyFilterBar } from "@/components/ui";
import { BookEarlyCard, BookEarlyFilters } from "@/components/happenings";

function bookEarlyCardKey(card: BookEarlyCardData): string {
  return card.kind === "happening" ? `happening-${card.happening.id}` : `event-${card.event.id}`;
}

/** Ask Fomo deep-link — plain `?q=` prefill (see app/(shell)/fomo/page.tsx's
 *  own doc comment on that param), not the `seed` mechanism, which pins a
 *  specific subject card and needs a type/id/name this page-level button has
 *  none of. */
const ASK_FOMO_HREF = `/fomo?q=${encodeURIComponent("What's worth booking early in Edinburgh?")}`;

/** GET /api/feed's `bookEarly` is already the FULL ranked list (Home only
 *  ever slices its first few) — this page reuses the same response rather
 *  than standing up a parallel /api/book-early route that would duplicate
 *  app/api/feed/route.ts's `buildBookEarly`. Same principle as
 *  app/(shell)/deals/page.tsx's `fetchDeals`. `window` doesn't affect
 *  `bookEarly` (it's independent of the request's window — see that route's
 *  own doc comment), so it's fixed here.
 *
 *  Throws (rather than swallowing to `null`) on a network error or non-2xx
 *  status — same "let the caller tell failure from empty" contract as
 *  fetchDeals. */
async function fetchBookEarly(): Promise<BookEarlyCardData[]> {
  const res = await fetch("/api/feed?window=now");
  if (!res.ok) throw new Error(`GET /api/feed ${res.status}`);
  const json = (await res.json()) as FeedResponse;
  return json.bookEarly;
}

/**
 * Book Early — its own full page (moved out of Home's in-place "Show all N"
 * expander per the task brief: Book Early and Free Any Time each get a
 * dedicated destination with their own filters and an Ask Fomo entry point,
 * reached from Home via a "See all" link instead of growing Home in place).
 * Same ranking/labels as the Home section (lib/happenings/book-early.ts) —
 * this page adds three client-side filters (timing / category / month, see
 * lib/happenings/book-early-filters.ts) over the identical full list.
 */
export default function BookEarlyPage() {
  const [cards, setCards] = useState<BookEarlyCardData[] | null>(null);
  const [error, setError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [alertHappeningIds, setAlertHappeningIds] = useState<Set<string>>(new Set());
  const [timing, setTiming] = useState<BookEarlyTiming | null>(null);
  const [category, setCategory] = useState<HappeningCategory | null>(null);
  const [month, setMonth] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const json = await fetchBookEarly();
        if (!cancelled) {
          setCards(json);
          setError(false);
        }
      } catch (err) {
        console.error("[book-early] /api/feed fetch failed", err);
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  // Same "Notify me" membership fetch as Home (app/(shell)/page.tsx) — a
  // BookEarlyCard needs to know up front whether the caller already has an
  // on-sale alert for it, or the button flashes "Notify me" before resetting
  // to "Notified" a moment later.
  useEffect(() => {
    if (!NOTIFY_ME_ENABLED) return;
    let cancelled = false;
    fetch("/api/alerts")
      .then((res) => res.json())
      .then((json: { happeningIds?: string[] }) => {
        if (!cancelled) setAlertHappeningIds(new Set(json.happeningIds ?? []));
      })
      .catch((err) => console.error("[book-early] /api/alerts fetch failed", err));
    return () => {
      cancelled = true;
    };
  }, []);

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

  return (
    <div className="flex flex-col gap-5 pb-8">
      <PageHeader title="Book Early" showBack />

      <div className="flex flex-col gap-4 px-4">
        <p className="text-body-sm text-on-surface-variant">
          Big dates worth booking before they sell out
        </p>

        <StickyFilterBar className="-mx-4 px-4">
          <div className="flex items-start justify-end gap-2">
            <BookEarlyFilters
              timing={timing}
              category={category}
              month={month}
              categoryOptions={categoryOptions}
              monthOptions={monthOptions}
              onTimingChange={setTiming}
              onCategoryChange={setCategory}
              onMonthChange={setMonth}
              resultCount={filteredCards.length}
            />
            <Link
              href={ASK_FOMO_HREF}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-surface px-3.5 py-1.5 text-label-sm font-semibold text-primary shadow-sm transition-colors hover:bg-surface-container"
            >
              <Icon name="chat" size={16} />
              Ask Fomo
            </Link>
          </div>
        </StickyFilterBar>

        {error ? (
          <ErrorState title="Couldn't load Book Early" onRetry={() => setReloadTick((t) => t + 1)} />
        ) : cards === null ? (
          <div className="flex flex-col gap-3 pt-2" role="status" aria-live="polite">
            <span className="sr-only">Loading Book Early…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-container" />
            ))}
          </div>
        ) : cards.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong p-8 text-center">
            <Icon name="confirmation_number" size={28} className="text-outline" />
            <p className="text-body-md text-on-surface-variant">Nothing to book early right now — check back soon.</p>
          </div>
        ) : filteredCards.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-hairline-strong py-6 text-center text-body-sm text-on-surface-variant">
            Nothing matches — clear filters
          </p>
        ) : (
          <div className="flex flex-col gap-3 pt-1">
            {filteredCards.map((card) => (
              <BookEarlyCard
                key={bookEarlyCardKey(card)}
                card={card}
                initialSubscribed={card.kind === "happening" && alertHappeningIds.has(card.happening.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
