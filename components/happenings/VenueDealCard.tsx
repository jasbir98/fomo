"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon, NavCard, SmartImage } from "@/components/ui";
import { WHO_GROUP_LABEL, type DealWhoGroup } from "@/lib/happenings/groups";
import { savingBadgeLabel } from "@/lib/happenings/format";
import { priceLabelForHappening, type PriceLabel } from "@/lib/happenings/price-label";
import { PriceTag } from "@/components/happenings/PriceTag";
import { useEffectiveWho } from "@/lib/personalise/useEffectiveWho";
import type { DealCardData } from "@/lib/happenings/feed-types";
import { track, priceBand } from "@/lib/analytics/track";

export interface VenueDealCardProps {
  /** `null` when this group has no resolvable `places` row (a normalised-
   *  venue-name fallback match — see lib/happenings/feed-types.ts's
   *  `VenueDealGroup` doc comment). There's then no `/place/[id]` to link
   *  to, so the card expands inline instead of navigating. */
  placeId: string | null;
  placeName: string;
  placeImageUrl: string | null;
  district: string | null;
  /** The subset of this venue's offers that currently match the active WHAT/WHO filters — the caller (app/(shell)/page.tsx) does the filtering so this component never needs to know about filter state, just what to render. */
  offers: DealCardData[];
  /** 0-based index within the /deals list — `card_opened`'s `position`. */
  position?: number;
}

/**
 * The best short saving to show as the card's price tag — the offer with the
 * largest `saving_amount`, falling back to the first offer when none carry a
 * numeric amount. Goes through `priceLabelForHappening` (the one shared price
 * label every card uses, PM decision 2026-09-26) rather than the raw
 * `saving_label` sentence — that field is often a full clause ("One free
 * child ticket with each full-paying adult") that would blow out this card's
 * fixed-width pill exactly like FeedListCard's own doc comment warns against.
 */
function bestSaving(offers: DealCardData[]): PriceLabel | null {
  if (offers.length === 0) return null;
  const withAmount = offers.filter((o) => o.happening.saving_amount != null);
  const pick =
    withAmount.length > 0
      ? withAmount.reduce((best, o) =>
          (o.happening.saving_amount ?? 0) > (best.happening.saving_amount ?? 0) ? o : best
        )
      : offers[0];
  return priceLabelForHappening(pick.happening);
}

function VenueThumbnail({ placeImageUrl }: { placeImageUrl: string | null }) {
  const [imgError, setImgError] = useState(false);
  const showImage = placeImageUrl && !imgError;
  return (
    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-hairline bg-surface-container">
      {showImage ? (
        <SmartImage
          src={placeImageUrl}
          alt=""
          width={64}
          height={64}
          className="h-full w-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Icon name="storefront" size={22} className="text-outline" />
        </div>
      )}
    </div>
  );
}

function VenueDealSummary({
  placeName,
  district,
  offers,
  priceLabel,
}: {
  placeName: string;
  district: string | null;
  offers: DealCardData[];
  priceLabel: PriceLabel | null;
}) {
  const who = useEffectiveWho();
  const whoLabels = Array.from(
    new Set(offers.map((o) => o.who).filter((w): w is DealWhoGroup => w != null))
  ).map((w) => WHO_GROUP_LABEL[w]);
  // "You qualify" (task brief §3) — true when ANY of this venue's offers
  // matches the visitor's own eligibility set (lib/useSaved.ts's `who`,
  // derived from lib/personalise/usePrefs.ts) — a group card headlines one
  // offer but can hold several, so a qualifying offer buried in the
  // collapsed count still earns the badge.
  const qualifies = offers.some((o) => o.who != null && who.includes(o.who));

  return (
    <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
      <div className="flex items-center justify-between gap-1">
        <h5 className="truncate text-label-lg font-bold text-on-surface">{placeName}</h5>
        <PriceTag label={priceLabel} variant="compact" />
      </div>
      <span className="text-label-sm text-on-surface-variant">
        {offers.length} offer{offers.length === 1 ? "" : "s"}
        {district ? ` · ${district}` : ""}
      </span>
      {qualifies ? (
        <span className="inline-flex w-fit items-center gap-1 rounded-full bg-secondary-container/25 px-2 py-0.5 text-[11px] font-bold text-primary">
          <Icon name="check_circle" filled size={12} />
          You qualify
        </span>
      ) : whoLabels.length > 0 ? (
        <span className="truncate text-label-sm text-secondary">{whoLabels.join(" · ")}</span>
      ) : null}
    </div>
  );
}

/**
 * One row per offer inside an expanded, place-less venue group — each links
 * straight to its own `/happening/[id]` (there's no `/place/[id]` for this
 * venue to gather them on, see the module doc above).
 */
function ExpandedOfferRow({ offer }: { offer: DealCardData }) {
  const badge = savingBadgeLabel(offer.happening);
  return (
    <Link
      href={`/happening/${offer.happening.id}`}
      className="flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-body-sm text-on-surface hover:bg-surface-container"
    >
      <span className="truncate">{offer.happening.title}</span>
      {badge ? <span className="shrink-0 text-label-sm font-bold text-primary">{badge}</span> : null}
    </Link>
  );
}

/**
 * One card per venue with multiple live deals (Home restructure task 3) —
 * venue photo, name, district, "N offers", best saving badge, a summary of
 * which WHO groups its offers cover.
 *
 * Taps through to `/place/[id]` when `placeId` resolved to a real place,
 * which lists every offer there in full (its own "Offers here" section).
 * When it didn't (a normalised-venue-name fallback group — see
 * `VenueDealCardProps`'s doc comment), there's nowhere to send the tap, so
 * the card expands in place instead, listing each offer with its own link.
 */
export function VenueDealCard({ placeId, placeName, placeImageUrl, district, offers, position }: VenueDealCardProps) {
  const [expanded, setExpanded] = useState(false);
  const priceLabel = bestSaving(offers);

  if (placeId) {
    return (
      <NavCard
        href={`/place/${placeId}`}
        ariaLabel={placeName}
        onNavigate={() =>
          track("card_opened", {
            kind: "place",
            id: placeId,
            source: "venue_group",
            surface: "deals",
            position,
            price_band: priceBand(offers.some((o) => o.happening.is_free)),
          })
        }
        className="flex cursor-pointer items-center gap-3.5 rounded-2xl bg-surface-container-lowest p-3.5 shadow-level-1 transition-shadow hover:shadow-level-2"
      >
        <VenueThumbnail placeImageUrl={placeImageUrl} />
        <VenueDealSummary placeName={placeName} district={district} offers={offers} priceLabel={priceLabel} />
      </NavCard>
    );
  }

  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-surface-container-lowest p-3.5 shadow-level-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-3.5 text-left"
      >
        <VenueThumbnail placeImageUrl={placeImageUrl} />
        <VenueDealSummary placeName={placeName} district={district} offers={offers} priceLabel={priceLabel} />
        <Icon name={expanded ? "expand_less" : "expand_more"} size={20} className="shrink-0 text-outline" />
      </button>
      {expanded ? (
        <div className="flex flex-col divide-y divide-hairline border-t border-hairline pt-1">
          {offers.map((offer) => (
            <ExpandedOfferRow key={offer.happening.id} offer={offer} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default VenueDealCard;
