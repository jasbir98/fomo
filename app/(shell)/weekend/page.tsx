"use client";

import { Suspense, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { FeedCardData, FeedResponse, FeedWindow } from "@/lib/happenings/feed-types";
import { weekendDates } from "@/lib/happenings/format";
import { isFreeCard } from "@/lib/happenings/price-label";
import { useCachedJson } from "@/lib/http/clientCache";
import { useProgressiveReveal } from "@/lib/useProgressiveReveal";
import { Chip, ErrorState, FeedbackLink, Icon, PageHeader, ShareButton, StickyFilterBar } from "@/components/ui";
import { FeedListCard, SubscribeCard } from "@/components/happenings";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { cardOnDay } from "@/components/happenings/DateFilterRow";
import { track } from "@/lib/analytics/track";

/** Matches Home's and What's on's `FEED_STALE_MS`. */
const FEED_STALE_MS = 60_000;

function cardKey(card: FeedCardData): string {
  if (card.kind === "happening") return `happening-${card.happening.id}`;
  if (card.kind === "series") return `series-${card.key}`;
  if (card.kind === "recurring") return `recurring-${card.key}`;
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
 * The feed's two date windows are disjoint (`now` = the rest of today,
 * `coming_up` = tomorrow onwards), so on Fri–Sun the weekend straddles both. Fetches
 * both under the same `feed:${window}` cache keys Home and What's on use,
 * merges, dedupes and keeps cards on this Saturday or Sunday.
 */
function WeekendPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const now = useCachedJson<FeedResponse>("feed:now", (s) => fetchFeed("now", s), { staleMs: FEED_STALE_MS });
  const later = useCachedJson<FeedResponse>("feed:coming_up", (s) => fetchFeed("coming_up", s), {
    staleMs: FEED_STALE_MS,
  });
  const { saturday, sunday } = weekendDates();

  // Freshness badge / price label task (PM decision 2026-09-26): a "Free
  // only" toggle, state kept in the URL (`?free=1`) so an IG link like
  // askfomo.com/weekend?free=1 lands pre-filtered.
  const [freeOnly, setFreeOnlyState] = useState(searchParams.get("free") === "1");

  function setFreeOnly(next: boolean) {
    setFreeOnlyState(next);
    track("filter_used", { filter: "free_only", value: next, page: "weekend" });
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("free", "1");
    else params.delete("free");
    router.replace(`/weekend${params.toString() ? `?${params.toString()}` : ""}`, { scroll: false });
  }

  const allCards = useMemo(() => {
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

  const cards = useMemo(() => {
    if (!allCards) return null;
    return freeOnly ? allCards.filter(isFreeCard) : allCards;
  }, [allCards, freeOnly]);

  const dealCount = later.data?.deals ? countDeals(later.data.deals) : null;
  const error = (now.error != null && !now.data) || (later.error != null && !later.data);

  const revealSentinelRef = useRef<HTMLDivElement>(null);
  const revealCount = useProgressiveReveal(cards?.length ?? 0, null, revealSentinelRef, { vertical: true, step: 20 });

  return (
    <div className="flex flex-col pb-6">
      <PageHeader title="This weekend" action={<ShareButton
            title="This weekend in Edinburgh · Fomo"
            text="Free & cheap things to do in Edinburgh this weekend, via Fomo"
            url={typeof window === "undefined" ? "/weekend" : `${window.location.origin}/weekend`}
            kind="weekend"
          />} />

      <div className="flex flex-col gap-3 px-4 pt-1 lg:mx-auto lg:w-full lg:max-w-[1200px] lg:px-8 lg:pt-2">
        <p className="text-body-md text-on-surface-variant">
          Free, cheap and discounted things to do in Edinburgh on {dayLabel(saturday)} and {dayLabel(sunday)}.
        </p>

        {dealCount ? (
          <Link
            href="/deals"
            className="flex h-11 items-center gap-2 rounded-full bg-secondary-container px-4 text-on-secondary-container lg:self-start"
          >
            <Icon name="sell" size={20} />
            <span className="flex-1 text-label-lg font-bold">{dealCount} deals & offers running now</span>
            <Icon name="chevron_right" size={20} />
          </Link>
        ) : null}

        <StickyFilterBar className="-mx-4 px-4 lg:-mx-8 lg:px-8">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 px-1">
              <h2 className="text-headline-sm font-extrabold tracking-tight text-on-surface">What&rsquo;s on</h2>
              {cards ? (
                <span className="rounded-full border border-hairline-strong bg-surface-container px-2.5 py-0.5 text-label-sm font-extrabold text-primary">
                  {cards.length}
                </span>
              ) : null}
            </div>
            <Chip
              label="Free only"
              leadingIcon="check_circle"
              selected={freeOnly}
              onClick={() => setFreeOnly(!freeOnly)}
            />
          </div>
        </StickyFilterBar>

        {error ? (
          <ErrorState
            title="Couldn't load this weekend"
            onRetry={() => {
              now.revalidate();
              later.revalidate();
            }}
          />
        ) : cards === null ? (
          <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4 xl:grid-cols-3" role="status" aria-live="polite">
            <span className="sr-only">Loading this weekend…</span>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className={`h-24 animate-pulse rounded-lg bg-surface-container ${i === 3 ? "hidden lg:block" : i === 4 || i === 5 ? "hidden xl:block" : ""}`} />
            ))}
          </div>
        ) : cards.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong p-8 text-center">
            <FomoSpot mood="meh" pose="shrug" className="h-20 w-20" />
            <p className="text-body-md text-on-surface-variant">
              {freeOnly
                ? "Nothing free matches. Turn off Free only."
                : "Nothing lined up for this weekend yet. Check back soon."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 xl:grid-cols-3">
            {cards.slice(0, revealCount).map((card, i) => (
              <FeedListCard key={cardKey(card)} card={card} surface="weekend" position={i} />
            ))}
            {revealCount < cards.length ? <div ref={revealSentinelRef} className="h-1 lg:col-span-full" /> : null}
          </div>
        )}

      {/* Footer */}
      <div className="flex flex-col gap-3 border-t border-outline-variant px-4 pt-6 pb-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6 lg:px-0">
        <div className="flex flex-col gap-1">
          <p className="text-label-md font-semibold text-on-surface">Help us improve</p>
          <p className="text-body-sm text-on-surface-variant">Missing something? Have feedback?</p>
        </div>
        <div className="flex gap-2 lg:w-80">
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

        <SubscribeCard source="weekend" />
      </div>
    </div>
  );
}

export default function WeekendPage() {
  return (
    <Suspense fallback={null}>
      <WeekendPageInner />
    </Suspense>
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
