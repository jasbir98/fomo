"use client";

import { useMemo, useRef, useState } from "react";
import type { DealCardData, FeedResponse, VenueDealGroup } from "@/lib/happenings/feed-types";
import { matchesDealFilters, type DealWhatGroup, type DealWhoGroup } from "@/lib/happenings/groups";
import { useCachedJson } from "@/lib/http/clientCache";
import { useProgressiveReveal } from "@/lib/useProgressiveReveal";
import { ErrorState, StickyFilterBar } from "@/components/ui";
import { AppHeader } from "@/components/shell/AppHeader";
import { FeedListCard, VenueDealCard, DealFilters } from "@/components/happenings";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { usePrefs } from "@/lib/personalise/usePrefs";
import { personalBoost, reorderWithBoost, type BoostPrefs } from "@/lib/personalise/score";
import { useEffectiveWho } from "@/lib/personalise/useEffectiveWho";

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
async function fetchDeals(signal?: AbortSignal): Promise<FeedResponse["deals"]> {
  const res = await fetch("/api/feed?window=now", { signal });
  if (!res.ok) throw new Error(`GET /api/feed ${res.status}`);
  const json = (await res.json()) as FeedResponse;
  return json.deals;
}

/**
 * Deals & Offers — its own full page (moved out of Home in the Home
 * decluttering pass; see components/shell/BottomNav.tsx). Same WHAT/WHO
 * filter chips and venue-grouped/single card list Home used to render inline,
 * just with room to breathe and no competing sections above/below it.
 */
export default function DealsPage() {
  // Cached under a fixed key — a return visit (e.g. via the bottom nav)
  // paints instantly from what's already there instead of the hourglass
  // skeleton below; a real fetch failure with nothing cached still surfaces
  // as `error` (see fetchDeals's own doc comment on the throw contract).
  const dealsResult = useCachedJson<FeedResponse["deals"]>("deals", fetchDeals, { staleMs: DEALS_STALE_MS });
  const deals = dealsResult.data ?? null;
  const error = dealsResult.error != null && deals === null;
  const [dealWhat, setDealWhat] = useState<DealWhatGroup | null>(null);
  const [dealWho, setDealWho] = useState<DealWhoGroup | null>(null);
  const who = useEffectiveWho();
  const prefs = usePrefs();
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
        personalBoost(item.kind === "venue" ? item.group.offers[0] : item.card, boostPrefs)
      ),
    [unrankedDealItems, boostPrefs]
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
    <div className="flex flex-col gap-5 pb-8">
      <AppHeader title="Deals & Offers" />

      <div className="flex flex-col gap-4 px-4">
        <p className="text-body-sm text-on-surface-variant">
          Discounts, promo codes &amp; concessions around Edinburgh
        </p>

        <StickyFilterBar className="-mx-4 px-4">
          <div className="flex justify-end">
            <DealFilters
              what={dealWhat}
              who={dealWho}
              onWhatChange={setDealWhat}
              onWhoChange={setDealWho}
              resultCount={dealItems.length}
            />
          </div>
        </StickyFilterBar>

        {error ? (
          <ErrorState title="Couldn't load deals" onRetry={() => dealsResult.revalidate()} />
        ) : deals === null ? (
          <div className="flex flex-col gap-3 pt-2" role="status" aria-live="polite">
            <span className="sr-only">Loading deals…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-lg bg-surface-container" />
            ))}
          </div>
        ) : totalBeforeFilters === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong p-8 text-center">
            <FomoSpot mood="meh" pose="shrug" className="h-20 w-20" />
            <p className="text-body-md text-on-surface-variant">No live deals right now — check back soon.</p>
          </div>
        ) : dealItems.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong py-6 text-center">
            <FomoSpot mood="hmm" pose="shrug" className="h-16 w-16" />
            <p className="text-body-sm text-on-surface-variant">No deals match — clear filters</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 pt-1">
            {dealItems.slice(0, visibleCount).map((item) =>
              item.kind === "venue" ? (
                <VenueDealCard
                  key={`venue-${item.group.placeId ?? item.group.placeName}`}
                  placeId={item.group.placeId}
                  placeName={item.group.placeName}
                  placeImageUrl={item.group.placeImageUrl}
                  district={item.group.district}
                  offers={item.group.offers}
                />
              ) : (
                <FeedListCard
                  key={`single-${item.card.happening.id}`}
                  card={{ kind: "happening", happening: item.card.happening, occurrence: item.card.occurrence }}
                />
              )
            )}
            {visibleCount < dealItems.length ? <div ref={revealSentinelRef} className="h-1" /> : null}
          </div>
        )}
      </div>
    </div>
  );
}
