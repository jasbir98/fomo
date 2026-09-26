"use client";

import { useMemo, useRef } from "react";
import Link from "next/link";
import type { FeedCardData, FeedResponse, FeedWindow } from "@/lib/happenings/feed-types";
import { weekendDates } from "@/lib/happenings/format";
import { useCachedJson } from "@/lib/http/clientCache";
import { useProgressiveReveal } from "@/lib/useProgressiveReveal";
import { ErrorState, Icon, PageHeader, ShareButton } from "@/components/ui";
import { FeedListCard, SubscribeCard } from "@/components/happenings";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { cardOnDay } from "@/components/happenings/DateFilterRow";

/** Matches Home's and What's on's `FEED_STALE_MS`. */
const FEED_STALE_MS = 60_000;

function cardKey(card: FeedCardData): string {
  if (card.kind === "happening") return `happening-${card.happening.id}`;
  if (card.kind === "series") return `series-${card.key}`;
  return `event-${card.event.id}`;
}

async function fetchFeed(window: Exclude<FeedWindow, "book_early">, signal?: AbortSignal): Promise<FeedResponse> {
  const res = await fetch(`/api/feed?window=${window}`, { signal });
  if (!res.ok) throw new Error(`GET /api/feed ${res.status}`);
  return (await res.json()) as FeedResponse;
}

/**
 * This weekend in Edinburgh — the public, time-first page the Instagram
 * link-in-bio and the weekly email point at (askfomo.com/weekend).
 *
 * The feed's two date windows are disjoint (`now` = today + tomorrow,
 * `coming_up` = after), so on Fri–Sun the weekend straddles both. Fetches
 * both under the same `feed:${window}` cache keys Home and What's on use,
 * merges, dedupes and keeps cards on this Saturday or Sunday.
 */
export default function WeekendPage() {
  const now = useCachedJson<FeedResponse>("feed:now", (s) => fetchFeed("now", s), { staleMs: FEED_STALE_MS });
  const later = useCachedJson<FeedResponse>("feed:coming_up", (s) => fetchFeed("coming_up", s), {
    staleMs: FEED_STALE_MS,
  });
  const { saturday, sunday } = weekendDates();

  const cards = useMemo(() => {
    if (!now.data || !later.data) return null;
    const seen = new Set<string>();
    const out: FeedCardData[] = [];
    for (const card of [...(now.data.whatsOn[0]?.cards ?? []), ...(later.data.whatsOn[0]?.cards ?? [])]) {
      const key = cardKey(card);
      if (seen.has(key) || !(cardOnDay(card, saturday) || cardOnDay(card, sunday))) continue;
      seen.add(key);
      out.push(card);
    }
    return out;
  }, [now.data, later.data, saturday, sunday]);

  const dealCount = later.data?.deals ? countDeals(later.data.deals) : null;
  const error = (now.error != null && !now.data) || (later.error != null && !later.data);

  const revealSentinelRef = useRef<HTMLDivElement>(null);
  const revealCount = useProgressiveReveal(cards?.length ?? 0, null, revealSentinelRef, { vertical: true, step: 20 });

  return (
    <div className="flex flex-col gap-5 pb-8">
      <PageHeader title="This weekend" action={<ShareButton
            title="This weekend in Edinburgh — Fomo"
            text="Free & cheap things to do in Edinburgh this weekend — found on Fomo"
            url={typeof window === "undefined" ? "/weekend" : `${window.location.origin}/weekend`}
          />} />

      <div className="flex flex-col gap-4 px-4">
        <p className="text-body-md text-on-surface-variant">
          Free, cheap and discounted things to do in Edinburgh on {dayLabel(saturday)} and {dayLabel(sunday)}.
        </p>

        {dealCount ? (
          <Link
            href="/deals"
            className="flex items-center gap-3 rounded-2xl bg-secondary-container px-4 py-3 text-on-secondary-container"
          >
            <Icon name="sell" size={22} />
            <span className="flex-1 text-title-sm font-bold">{dealCount} deals & offers running now</span>
            <Icon name="chevron_right" size={22} />
          </Link>
        ) : null}

        <div className="flex items-center justify-between px-1">
          <h2 className="text-headline-sm font-extrabold tracking-tight text-on-surface">What&rsquo;s on</h2>
          {cards ? (
            <span className="rounded-full border border-hairline-strong bg-surface-container px-2.5 py-0.5 text-label-sm font-extrabold text-primary">
              {cards.length}
            </span>
          ) : null}
        </div>

        {error ? (
          <ErrorState
            title="Couldn't load this weekend"
            onRetry={() => {
              now.revalidate();
              later.revalidate();
            }}
          />
        ) : cards === null ? (
          <div className="flex flex-col gap-3 pt-2" role="status" aria-live="polite">
            <span className="sr-only">Loading this weekend…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-container" />
            ))}
          </div>
        ) : cards.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong p-8 text-center">
            <FomoSpot mood="meh" pose="shrug" className="h-20 w-20" />
            <p className="text-body-md text-on-surface-variant">Nothing lined up for this weekend yet — check back soon.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 pt-1">
            {cards.slice(0, revealCount).map((card) => (
              <FeedListCard key={cardKey(card)} card={card} />
            ))}
            {revealCount < cards.length ? <div ref={revealSentinelRef} className="h-1" /> : null}
          </div>
        )}

        <SubscribeCard source="weekend" />
      </div>
    </div>
  );
}

function dayLabel(dayDate: string): string {
  const [y, m, d] = dayDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function countDeals(deals: FeedResponse["deals"]): number {
  return deals.singles.length + deals.venueGroups.reduce((n, g) => n + g.offers.length, 0);
}
