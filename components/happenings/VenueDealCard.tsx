"use client";

import { useState } from "react";
import { Icon, NavCard } from "@/components/ui";
import { WHO_GROUP_LABEL, type DealWhoGroup } from "@/lib/happenings/groups";
import { savingBadgeLabel } from "@/lib/happenings/format";
import type { DealCardData } from "@/lib/happenings/feed-types";

export interface VenueDealCardProps {
  placeId: string;
  placeName: string;
  placeImageUrl: string | null;
  district: string | null;
  /** The subset of this venue's offers that currently match the active WHAT/WHO filters — the caller (app/(shell)/page.tsx) does the filtering so this component never needs to know about filter state, just what to render. */
  offers: DealCardData[];
}

/**
 * The best short saving to show as the card's badge — the offer with the
 * largest `saving_amount`, falling back to the first offer when none carry a
 * numeric amount. Goes through `savingBadgeLabel` (same short-badge deriver
 * every other card uses) rather than the raw `saving_label` sentence — that
 * field is often a full clause ("One free child ticket with each full-paying
 * adult") that would blow out this card's fixed-width pill exactly like
 * FeedListCard's own doc comment warns against.
 */
function bestSaving(offers: DealCardData[]): string | null {
  if (offers.length === 0) return null;
  const withAmount = offers.filter((o) => o.happening.saving_amount != null);
  const pick =
    withAmount.length > 0
      ? withAmount.reduce((best, o) =>
          (o.happening.saving_amount ?? 0) > (best.happening.saving_amount ?? 0) ? o : best
        )
      : offers[0];
  return savingBadgeLabel(pick.happening);
}

/**
 * One card per venue with multiple live deals (Home restructure task 3) —
 * venue photo, name, district, "N offers", best saving badge, a summary of
 * which WHO groups its offers cover. Taps through to `/place/[id]`, which
 * lists every offer at that venue in full (its own "Offers here" section).
 */
export function VenueDealCard({ placeId, placeName, placeImageUrl, district, offers }: VenueDealCardProps) {
  const [imgError, setImgError] = useState(false);
  const showImage = placeImageUrl && !imgError;
  const badge = bestSaving(offers);
  const whoLabels = Array.from(
    new Set(offers.map((o) => o.who).filter((w): w is DealWhoGroup => w != null))
  ).map((w) => WHO_GROUP_LABEL[w]);

  return (
    <NavCard
      href={`/place/${placeId}`}
      ariaLabel={placeName}
      className="flex cursor-pointer items-center gap-3.5 rounded-2xl bg-surface-container-lowest p-3.5 shadow-level-1 transition-shadow hover:shadow-level-2"
    >
      <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-hairline bg-surface-container">
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={placeImageUrl!}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Icon name="storefront" size={22} className="text-outline" />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <div className="flex items-center justify-between gap-1">
          <h5 className="truncate text-label-lg font-bold text-on-surface">{placeName}</h5>
          {badge ? (
            <span className="shrink-0 rounded-full bg-surface-container px-2 py-0.5 text-[10px] font-extrabold text-primary">
              {badge}
            </span>
          ) : null}
        </div>
        <span className="text-label-sm text-on-surface-variant">
          {offers.length} offer{offers.length === 1 ? "" : "s"}
          {district ? ` · ${district}` : ""}
        </span>
        {whoLabels.length > 0 ? (
          <span className="truncate text-label-sm text-secondary">{whoLabels.join(" · ")}</span>
        ) : null}
      </div>
    </NavCard>
  );
}

export default VenueDealCard;
