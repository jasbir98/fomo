"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon, NavCard, NavCardLink } from "@/components/ui";
import { DealPhoto } from "@/components/happenings/DealPhoto";
import { dealGroupSubtitle } from "@/lib/happenings/deal-label";
import { savingBadgeLabel } from "@/lib/happenings/format";
import { priceLabelForHappening, type PriceLabel } from "@/lib/happenings/price-label";
import { PriceTag } from "@/components/happenings/PriceTag";
import { useEffectiveWho } from "@/lib/personalise/useEffectiveWho";
import type { DealCardData } from "@/lib/happenings/feed-types";
import { track, priceBand } from "@/lib/analytics/track";
import { FindBadge } from "@/components/finds/FindBadge";
import { useFindKeys } from "@/lib/finds/useFinds";
import { findKey } from "@/lib/finds/types";

export interface VenueDealCardProps {
  /** `null` when this group has no resolvable `places` row (a normalised-
   *  venue-name fallback match — see lib/happenings/feed-types.ts's
   *  `VenueDealGroup` doc comment). There's then no `/place/[id]` to link
   *  to, so the card expands inline instead of navigating. */
  placeId: string | null;
  placeName: string;
  placeImageUrl: string | null;
  /** Kept for caller compatibility; no longer rendered (the subtitle now carries the offer, not the area). */
  district?: string | null;
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

/** Photo order: any offer's own image, the linked place's photo, then the category default photo (DealPhoto appends it) — never a glyph tile. */
function VenueThumbnail({ placeImageUrl, offers }: { placeImageUrl: string | null; offers: DealCardData[] }) {
  const sources = [...offers.map((o) => o.happening.image_url), placeImageUrl];
  return (
    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-hairline bg-surface-container">
      <DealPhoto sources={sources} category={offers[0]?.happening.category} title={offers[0]?.happening.title} venueName={offers[0]?.happening.venue_name} width={64} height={64} className="h-full w-full object-cover" />
    </div>
  );
}

function VenueDealSummary({
  placeName,
  offers,
  priceLabel,
}: {
  placeName: string;
  offers: DealCardData[];
  priceLabel: PriceLabel | null;
}) {
  const who = useEffectiveWho();
  // Any of this venue's offers hand-picked for "For you"? Show the pill under
  // the subtitle; the card itself still links to the whole venue.
  const findKeys = useFindKeys();
  const hasFind = offers.some((o) => findKeys.has(findKey("happening", o.happening.id)));
  // Offer in plain words + count ("Up to 30% off · 2 deals"); the title above is the venue.
  const best = dealGroupSubtitle(offers.map((o) => o.happening));
  const count = `${offers.length} deal${offers.length === 1 ? "" : "s"}`;
  const subtitle = best ? `${best} · ${count}` : count;
  // "You qualify" (task brief §3) — true when ANY of this venue's offers
  // matches the visitor's own eligibility set (lib/useSaved.ts's `who`,
  // derived from lib/personalise/usePrefs.ts) — a group card headlines one
  // offer but can hold several, so a qualifying offer buried in the
  // collapsed count still earns the badge.
  const qualifies = offers.some((o) => o.who != null && who.includes(o.who));

  return (
    <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
      <div className="flex items-center justify-between gap-1">
        <h5 className="line-clamp-2 text-label-lg font-bold leading-snug text-on-surface"><NavCardLink>{placeName}</NavCardLink></h5>
        <PriceTag label={priceLabel} variant="compact" />
      </div>
      <span className="line-clamp-1 text-body-sm text-on-surface-variant">{subtitle}</span>
      {hasFind ? <FindBadge className="mt-0.5" /> : null}
      {qualifies ? (
        <span className="inline-flex w-fit items-center gap-1 rounded-full bg-secondary-container/25 px-2 py-0.5 text-label-sm font-bold text-primary">
          <Icon name="check_circle" filled size={12} />
          You qualify
        </span>
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
 * venue photo (own image, place photo, else category default photo), venue name, best saving badge, offer subtitle + deal count, a summary of
 * which WHO groups its offers cover.
 *
 * Taps through to `/place/[id]` when `placeId` resolved to a real place,
 * which lists every offer there in full (its own "Offers here" section).
 * When it didn't (a normalised-venue-name fallback group — see
 * `VenueDealCardProps`'s doc comment), there's nowhere to send the tap, so
 * the card expands in place instead, listing each offer with its own link.
 */
export function VenueDealCard({ placeId, placeName, placeImageUrl, offers, position }: VenueDealCardProps) {
  const [expanded, setExpanded] = useState(false);
  const priceLabel = bestSaving(offers);

  if (placeId) {
    return (
      <NavCard
        href={`/place/${placeId}`}
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
        <VenueThumbnail placeImageUrl={placeImageUrl} offers={offers} />
        <VenueDealSummary placeName={placeName} offers={offers} priceLabel={priceLabel} />
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
        <VenueThumbnail placeImageUrl={placeImageUrl} offers={offers} />
        <VenueDealSummary placeName={placeName} offers={offers} priceLabel={priceLabel} />
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
