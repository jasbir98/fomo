"use client";

import { useEffect, useMemo, useState } from "react";
import type { DealCardData, FeedResponse, VenueDealGroup } from "@/lib/happenings/feed-types";
import { matchesDealFilters, type DealWhatGroup, type DealWhoGroup } from "@/lib/happenings/groups";
import { Icon, PageHeader, StickyFilterBar } from "@/components/ui";
import { FeedListCard, VenueDealCard, DealFilters } from "@/components/happenings";

type DealListItem =
  | { kind: "venue"; group: VenueDealGroup }
  | { kind: "single"; card: DealCardData };

/** GET /api/feed already computes the whole `deals` section (venue-grouped +
 *  singles, WHAT/WHO facets precomputed) for Home's old Deals & Offers
 *  section — this page just consumes the same response instead of standing
 *  up a parallel /api/deals route that would duplicate app/api/feed/route.ts's
 *  `buildDealsSection`/`buildDealCards`. `window` doesn't affect `deals` (see
 *  that route's own doc comment), so the query param is fixed here. */
async function fetchDeals(): Promise<FeedResponse["deals"] | null> {
  try {
    const res = await fetch("/api/feed?window=now");
    const json = (await res.json()) as FeedResponse;
    return json.deals;
  } catch (err) {
    console.error("[deals] /api/feed fetch failed", err);
    return null;
  }
}

/**
 * Deals & Offers — its own full page (moved out of Home in the Home
 * decluttering pass; see components/shell/BottomNav.tsx). Same WHAT/WHO
 * filter chips and venue-grouped/single card list Home used to render inline,
 * just with room to breathe and no competing sections above/below it.
 */
export default function DealsPage() {
  const [deals, setDeals] = useState<FeedResponse["deals"] | null>(null);
  const [dealWhat, setDealWhat] = useState<DealWhatGroup | null>(null);
  const [dealWho, setDealWho] = useState<DealWhoGroup | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const json = await fetchDeals();
      if (!cancelled) setDeals(json);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const dealItems: DealListItem[] = useMemo(
    () => [
      ...filteredVenueGroups.map((group): DealListItem => ({ kind: "venue", group })),
      ...filteredSingles.map((card): DealListItem => ({ kind: "single", card })),
    ],
    [filteredVenueGroups, filteredSingles]
  );

  const totalBeforeFilters = (deals?.venueGroups.length ?? 0) + (deals?.singles.length ?? 0);

  return (
    <div className="flex flex-col gap-5 pb-8">
      <PageHeader title="Deals & Offers" showBack />

      <div className="flex flex-col gap-4 px-4">
        <p className="text-body-sm text-on-surface-variant">
          Standing discounts, promo codes &amp; savings — valid whenever you go
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

        {deals === null ? (
          <div className="flex flex-col gap-3 pt-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-lg bg-surface-container" />
            ))}
          </div>
        ) : totalBeforeFilters === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-hairline-strong p-8 text-center">
            <Icon name="sell" size={28} className="text-outline" />
            <p className="text-body-md text-on-surface-variant">No live deals right now — check back soon.</p>
          </div>
        ) : dealItems.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-hairline-strong py-6 text-center text-body-sm text-on-surface-variant">
            No deals match — clear filters
          </p>
        ) : (
          <div className="flex flex-col gap-3 pt-1">
            {dealItems.map((item) =>
              item.kind === "venue" ? (
                <VenueDealCard
                  key={`venue-${item.group.placeId}`}
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
          </div>
        )}
      </div>
    </div>
  );
}
