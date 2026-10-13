"use client";

import { useMemo, useRef, useState } from "react";
import type { DealCardData, FeedResponse, VenueDealGroup } from "@/lib/happenings/feed-types";
import { matchesDealFilters, type DealWhatGroup, type DealWhoGroup } from "@/lib/happenings/groups";
import { useCachedJson } from "@/lib/http/clientCache";
import { useProgressiveReveal } from "@/lib/useProgressiveReveal";
import { ErrorState, StickyFilterBar } from "@/components/ui";
import { AppHeader } from "@/components/shell/AppHeader";
import Link from "next/link";
import { FeedListCard, VenueDealCard, DealFilters } from "@/components/happenings";
import { FeedbackLink } from "@/components/ui";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { usePrefs } from "@/lib/personalise/usePrefs";
import { personalBoost, reorderWithBoost, type BoostPrefs } from "@/lib/personalise/score";
import { useEffectiveWho } from "@/lib/personalise/useEffectiveWho";
import { useAffinity } from "@/lib/personalise/useAffinity";
import { track } from "@/lib/analytics/track";

type DealListItem =
  | { kind: "venue"; group: VenueDealGroup }
  | { kind: "single"; card: DealCardData };

/** Matches Home's own feed staleness (app/(shell)/page.tsx's `FEED_STALE_MS`) — can't import that constant across route boundaries without pulling in Home's other module state, so it's duplicated here as a plain number. */
const DEALS_STALE_MS = 60_000;

/** GET /api/feed already computes the whole `deals` section (venue-grouped +
 *  singles, WHAT/WHO facets precomputed) for Home's old Deals & Offers
 *  section — this page just consumes the same response instead of standing
 *  up a parallel /api/deals route that would duplicate app/api/feed/route.ts's
 *  `buildDealsSection`/`buildDealCards`. `window` doesn't affect `deals` (see
 *  that route's own doc comment), so the query param is fixed here.
 *
 *  Throws (rather than swallowing to `null`) on a network error or a
 *  non-2xx status — GET /api/feed's catch block now returns 401/500, not a
 *  silent 200 with empty sections — so `useCachedJson` below can tell "the
 *  request failed" apart from "the response was genuinely empty" instead of
 *  both looking like the same `null`. */
async function fetchFeedNow(signal?: AbortSignal): Promise<FeedResponse> {
  const res = await fetch("/api/feed?window=now", { signal });
  if (!res.ok) throw new Error(`GET /api/feed ${res.status}`);
  return (await res.json()) as FeedResponse;
}

export interface DealsClientProps {
  /**
   * The deals section built on the server (app/(shell)/deals/page.tsx), so the
   * first HTML already lists real deals. Only a fallback until the client's
   * own cached/fetched feed arrives; never written into the shared `feed:now`
   * cache, which other pages read expecting the full response.
   */
  initialDeals?: FeedResponse["deals"] | null;
}

/**
 * Deals & Offers — its own full page (moved out of Home in the Home
 * decluttering pass; see components/shell/BottomNav.tsx). Same WHAT/WHO
 * filter chips and venue-grouped/single card list Home used to render inline,
 * just with room to breathe and no competing sections above/below it.
 */
export function DealsClient({ initialDeals = null }: DealsClientProps) {
  // A return visit paints instantly from what's already there instead of the
  // skeleton below; a real fetch failure with nothing cached still surfaces
  // as `error` (see fetchFeedNow's throw contract).
  // The FULL feed under Home's own `feed:now` key (same URL), not just the
  // deals slice under a private key — so arriving from Home, What's on, Book
  // early or Free paints instantly instead of re-fetching the whole feed.
  const dealsResult = useCachedJson<FeedResponse>("feed:now", fetchFeedNow, { staleMs: DEALS_STALE_MS });
  const deals = dealsResult.data?.deals ?? initialDeals;
  const error = dealsResult.error != null && deals === null;
  const [dealWhat, setDealWhat] = useState<DealWhatGroup | null>(null);
  const [dealWho, setDealWho] = useState<DealWhoGroup | null>(null);

  function handleWhatChange(value: DealWhatGroup | null) {
    setDealWhat(value);
    track("filter_used", { filter: "what", value, page: "deals" });
  }

  function handleWhoChange(value: DealWhoGroup | null) {
    setDealWho(value);
    track("filter_used", { filter: "who", value, page: "deals" });
  }
  const who = useEffectiveWho();
  const prefs = usePrefs();
  const affinity = useAffinity();
  const boostPrefs: BoostPrefs = useMemo(
    () => ({ interests: prefs.interests, budget: prefs.budget, who }),
    [prefs.interests, prefs.budget, who]
  );

  const filteredVenueGroups = useMemo(() => {
    if (!deals) return [];
    return deals.venueGroups
      .map((group) => ({ ...group, offers: group.offers.filter((o) => matchesDealFilters(o, dealWhat, dealWho)) }))
      .filter((group) => group.offers.length > 0);
  }, [deals, dealWhat, dealWho]);

  const filteredSingles = useMemo(() => {
    if (!deals) return [];
    return deals.singles.filter((c) => matchesDealFilters(c, dealWhat, dealWho));
  }, [deals, dealWhat, dealWho]);

  const unrankedDealItems: DealListItem[] = useMemo(
    () => [
      ...filteredVenueGroups.map((group): DealListItem => ({ kind: "venue", group })),
      ...filteredSingles.map((card): DealListItem => ({ kind: "single", card })),
    ],
    [filteredVenueGroups, filteredSingles]
  );

  // Personalisation ranking boost (lib/personalise/score.ts, task brief §3)
  // — a gentle nudge over the filtered list, never a re-filter; a venue
  // group's own best-ranked offer stands in for the whole card.
  const dealItems = useMemo(
    () =>
      reorderWithBoost(unrankedDealItems, (item) =>
        personalBoost(item.kind === "venue" ? item.group.offers[0] : item.card, boostPrefs, affinity)
      ),
    [unrankedDealItems, boostPrefs, affinity]
  );

  const totalBeforeFilters = (deals?.venueGroups.length ?? 0) + (deals?.singles.length ?? 0);

  // Renders in chunks of 20 rather than mounting the whole list at once — no
  // pagination on this endpoint (see the pagination audit in the caller's
  // report), so this is where the actual render cost gets capped instead.
  const revealSentinelRef = useRef<HTMLDivElement>(null);
  const visibleCount = useProgressiveReveal(dealItems.length, null, revealSentinelRef, {
    vertical: true,
    step: 20,
  });

  return (
    <div className="flex flex-col pb-6">
      <AppHeader title="Deals & offers in Edinburgh" />

      {/* Desktop: filters in a sticky left rail, results in a 2-col grid. Below lg the
          aside/main wrappers are `display: contents`, so the mobile flow (intro, sticky
          filter bar, list, footer) is exactly the flat sibling list it always was. */}
      <div className="flex flex-col gap-3 px-4 pt-3 lg:mx-auto lg:grid lg:w-full lg:max-w-[1200px] lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start lg:gap-x-8 lg:px-8 lg:pt-6">
        <aside className="contents lg:col-start-1 lg:row-start-1 lg:flex lg:max-h-[calc(100dvh-var(--topbar-h)-88px)] lg:flex-col lg:gap-4 lg:overflow-y-auto lg:sticky lg:top-[calc(var(--topbar-h)+64px)] lg:-mx-1 lg:px-1">
          <p className="text-body-md text-on-surface-variant">
            Student, local, under-26 and over-60 discounts around Edinburgh
          </p>

          <StickyFilterBar className="-mx-4 px-4 lg:hidden">
            <div className="flex items-start justify-between gap-2">
              <span className="px-1 pt-1.5 text-label-lg font-semibold text-on-surface-variant">
                {deals ? `${dealItems.length} ${dealItems.length === 1 ? "deal" : "deals"}` : ""}
              </span>
              <DealFilters
                what={dealWhat}
                who={dealWho}
                onWhatChange={handleWhatChange}
                onWhoChange={handleWhoChange}
                resultCount={deals ? dealItems.length : null}
              />
            </div>
          </StickyFilterBar>

          {/* Desktop-only second render of the (fully controlled) filters: its inline panel. */}
          <div className="hidden rounded-2xl bg-surface-container-lowest p-4 shadow-level-1 lg:block">
            <DealFilters
              what={dealWhat}
              who={dealWho}
              onWhatChange={handleWhatChange}
              onWhoChange={handleWhoChange}
              resultCount={deals ? dealItems.length : null}
            />
          </div>
        </aside>

        <div className="contents lg:col-start-2 lg:row-start-1 lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
          {error ? (
            <ErrorState title="Couldn't load deals" onRetry={() => dealsResult.revalidate()} />
          ) : deals === null ? (
            <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4 2xl:grid-cols-3" role="status" aria-live="polite">
              <span className="sr-only">Loading deals…</span>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className={`h-20 animate-pulse rounded-lg bg-surface-container ${i === 3 ? "hidden lg:block" : ""}`} />
              ))}
            </div>
          ) : totalBeforeFilters === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong p-8 text-center">
              <FomoSpot mood="meh" pose="shrug" className="h-20 w-20" />
              <p className="text-body-md text-on-surface-variant">No live deals right now. Check back soon.</p>
            </div>
          ) : dealItems.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong py-6 text-center">
              <FomoSpot mood="hmm" pose="shrug" className="h-16 w-16" />
              <p className="text-body-sm text-on-surface-variant">No deals match. Clear filters</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 2xl:grid-cols-3">
              {dealItems.slice(0, visibleCount).map((item, i) =>
                item.kind === "venue" ? (
                  <VenueDealCard
                    key={`venue-${item.group.placeId ?? item.group.placeName}`}
                    placeId={item.group.placeId}
                    placeName={item.group.placeName}
                    placeImageUrl={item.group.placeImageUrl}
                    district={item.group.district}
                    offers={item.group.offers}
                    position={i}
                  />
                ) : (
                  <FeedListCard
                    key={`single-${item.card.happening.id}`}
                    card={{ kind: "happening", happening: item.card.happening, occurrence: item.card.occurrence }}
                    surface="deals"
                    position={i}
                  />
                )
              )}
              {visibleCount < dealItems.length ? <div ref={revealSentinelRef} className="h-1 lg:col-span-full" /> : null}
            </div>
          )}

          {/* Footer */}
          <div className="flex flex-col gap-3 border-t border-outline-variant px-4 pt-6 pb-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6 lg:px-0">
            <div className="flex flex-col gap-1">
              <p className="text-label-md font-semibold text-on-surface">How can we help?</p>
              <p className="text-body-sm text-on-surface-variant">Missing a deal? Have an idea?</p>
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
        </div>
      </div>
    </div>
  );
}
