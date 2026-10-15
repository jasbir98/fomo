"use client";

import Link from "next/link";
import { Icon, NavCard, NavCardLink } from "@/components/ui";
import { categoryStyle } from "@/lib/happenings/category-style";
import { DealPhoto } from "@/components/happenings/DealPhoto";
import { dealCardTitle, dealGroupSubtitle, dealSubtitle } from "@/lib/happenings/deal-label";
import { savingBadgeLabel, shortStartTimeFromNote } from "@/lib/happenings/format";
import { weekdayOf, localDayDate } from "@/lib/happenings/occurrence";
import { CITY } from "@/lib/city";
import { useEffectiveWho } from "@/lib/personalise/useEffectiveWho";
import type { DealCardData } from "@/lib/happenings/feed-types";
import type { DealVenueGroup, RankedDealItem } from "@/lib/happenings/venue-deals";
import { happeningToPreview, prefetchHappening, setHappeningPreview } from "@/lib/happenings/preview-cache";
import { track, priceBand } from "@/lib/analytics/track";

export interface TodaysDealsStripProps {
  deals: RankedDealItem[];
  /** Defaults to `new Date()` — accepted so a caller (or a test) can pin "today" rather than this component reading the clock itself. */
  at?: Date;
  /** `card_opened`'s `surface` — this strip only ever renders on Home, so callers pass "home_today_deals". */
  surface?: "home_today_deals";
  /** Extra classes for the root `<section>` — Home renders this strip twice (a phone copy that is `lg:hidden`, and a desktop right-rail copy that is `hidden lg:flex`); see app/(shell)/page.tsx. */
  className?: string;
}

const WEEKDAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Compact card for the horizontal strip — a smaller, denser sibling of
 *  FeedListCard's row (which is sized for a vertical list, not a
 *  fixed-width scroller). Same tap target (`/happening/[id]`), same badge/
 *  thumbnail language (savingBadgeLabel, defaultImageFor) so it reads
 *  as the same app, just condensed. */
function TodaysDealCard({ card, surface, position }: { card: DealCardData; surface?: "home_today_deals"; position?: number }) {
  const { happening, who: cardWho } = card;
  const badge = savingBadgeLabel(happening);
  const style = categoryStyle(happening.category);
  const time = shortStartTimeFromNote(happening.time_note);
  // Title = venue short name, subtitle = the offer in plain words (lib/happenings/deal-label.ts).
  const title = dealCardTitle(happening);
  const subtitle = dealSubtitle(happening);
  // "You qualify" (task brief §3) — same eligibility check as
  // FeedListCard's HappeningRow and VenueDealCard, reading the precomputed
  // `who` facet this card already carries rather than re-deriving it.
  const who = useEffectiveWho();
  const qualifies = cardWho != null && who.includes(cardWho);

  return (
    <NavCard
      href={`/happening/${happening.id}`}
      onPointerDown={() => prefetchHappening(happening.id)}
      onNavigate={() => {
        setHappeningPreview(happening.id, happeningToPreview(happening, { priceLabel: badge, whenLabel: time }));
        track("card_opened", { kind: "happening", id: happening.id, source: happening.kind, surface, position, price_band: priceBand(happening.is_free) });
      }}
      className="flex w-44 shrink-0 cursor-pointer flex-col gap-2 rounded-2xl bg-surface-container-lowest p-3 shadow-level-1 transition-shadow hover:shadow-level-2 lg:w-full lg:flex-row lg:items-center lg:gap-3"
    >
      <div className="relative h-20 w-full shrink-0 overflow-hidden rounded-xl border border-hairline bg-surface-container lg:w-28">
        <DealPhoto sources={[happening.image_url]} category={happening.category} title={happening.title} venueName={happening.venue_name} width={160} height={80} className="h-full w-full object-cover" />
        {badge ? (
          <span className="absolute right-1 top-1 rounded-full border border-hairline-strong bg-surface-container-lowest/95 px-2 py-0.5 text-label-sm font-extrabold text-primary shadow-xs">
            {badge}
          </span>
        ) : null}
        {qualifies ? (
          <span className="absolute bottom-1 left-1 flex items-center gap-0.5 rounded-full bg-secondary-container/90 px-1.5 py-0.5 text-label-sm font-bold text-primary shadow-xs">
            <Icon name="check_circle" filled size={10} />
            You qualify
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1 text-label-sm font-bold uppercase tracking-wide">
          <Icon name={style.icon} size={11} className={style.textClass} />
          {time ? <span className="text-accent">{time}</span> : null}
        </div>
        <h5 className="line-clamp-2 text-label-lg font-bold leading-snug text-on-surface"><NavCardLink>{title}</NavCardLink></h5>
        {subtitle ? <p className="line-clamp-1 text-body-sm font-medium text-on-surface-variant">{subtitle}</p> : null}
      </div>
    </NavCard>
  );
}

/** The offer to headline a venue group with — largest `saving_amount`, else
 *  the first offer. Mirrors VenueDealCard's own `bestSaving` picker (kept as
 *  a separate small copy rather than a shared import — this one only ever
 *  needs the winning offer itself, not a full `PriceLabel`). */
function bestOffer(offers: DealCardData[]): DealCardData {
  const withAmount = offers.filter((o) => o.happening.saving_amount != null);
  if (withAmount.length === 0) return offers[0];
  return withAmount.reduce((best, o) => ((o.happening.saving_amount ?? 0) > (best.happening.saving_amount ?? 0) ? o : best));
}

/** Same card shape as `TodaysDealCard` (task: "keep card shape the same") —
 *  headlined by the venue's best offer, with a count chip instead of the
 *  usual price badge when there's more than one. Tapping it opens the
 *  venue's own grouped view: `/place/[id]` when the group resolved to a real
 *  place, else `/deals` (this strip is a fixed-width horizontal scroller, no
 *  room to expand a group inline the way VenueDealCard does on `/deals`). */
function TodaysDealGroupCard({ group, surface, position }: { group: DealVenueGroup; surface?: "home_today_deals"; position?: number }) {
  const headline = bestOffer(group.offers);
  const { happening } = headline;
  const style = categoryStyle(happening.category);
  // Photo order: any grouped deal's own image (headline first), the linked place's photo, then the category default photo (DealPhoto appends it).
  const photoSources = [happening.image_url, ...group.offers.map((o) => o.happening.image_url), group.placeImageUrl];
  const subtitle = dealGroupSubtitle(group.offers.map((o) => o.happening));
  const time = shortStartTimeFromNote(happening.time_note);
  const href = group.placeId ? `/place/${group.placeId}` : "/deals";
  // Same "You qualify" rule as VenueDealCard's own group summary — true when
  // ANY offer at this venue matches the visitor's eligibility set, not just
  // the headline offer this card otherwise borrows every other field from.
  const who = useEffectiveWho();
  const qualifies = group.offers.some((o) => o.who != null && who.includes(o.who));

  return (
    <NavCard
      href={href}
      onNavigate={() => {
        if (group.placeId) {
          track("card_opened", { kind: "place", id: group.placeId, source: "venue_group", surface, position, price_band: priceBand(happening.is_free) });
        }
      }}
      className="flex w-44 shrink-0 cursor-pointer flex-col gap-2 rounded-2xl bg-surface-container-lowest p-3 shadow-level-1 transition-shadow hover:shadow-level-2 lg:w-full lg:flex-row lg:items-center lg:gap-3"
    >
      <div className="relative h-20 w-full shrink-0 overflow-hidden rounded-xl border border-hairline bg-surface-container lg:w-28">
        <DealPhoto sources={photoSources} category={happening.category} title={happening.title} venueName={happening.venue_name} width={160} height={80} className="h-full w-full object-cover" />
        <span className="absolute right-1 top-1 rounded-full border border-hairline-strong bg-surface-container-lowest/95 px-2 py-0.5 text-label-sm font-extrabold text-primary shadow-xs">
          {group.offers.length} deals
        </span>
        {qualifies ? (
          <span className="absolute bottom-1 left-1 flex items-center gap-0.5 rounded-full bg-secondary-container/90 px-1.5 py-0.5 text-label-sm font-bold text-primary shadow-xs">
            <Icon name="check_circle" filled size={10} />
            You qualify
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1 text-label-sm font-bold uppercase tracking-wide">
          <Icon name={style.icon} size={11} className={style.textClass} />
          {time ? <span className="text-accent">{time}</span> : null}
        </div>
        <h5 className="line-clamp-2 text-label-lg font-bold leading-snug text-on-surface"><NavCardLink>{group.placeName}</NavCardLink></h5>
        {subtitle ? <p className="line-clamp-1 text-body-sm font-medium text-on-surface-variant">{subtitle}</p> : null}
      </div>
    </NavCard>
  );
}

/**
 * "Today's deals" — a horizontal strip surfacing deals valid TODAY in
 * Edinburgh time (lib/happenings/today-deals.ts's `todaysDeals`), placed on
 * Home just below the hero (see app/(shell)/page.tsx). The point is a daily
 * reason to open the app ("Tuesday: £5 pizza, 2-for-1 cinema…") — so this
 * renders nothing at all when the day's selection is too thin to read as a
 * real "today" list (see `todaysDeals`'s own MIN_RENDER_COUNT), rather than
 * padding out a one-card strip.
 */
export function TodaysDealsStrip({ deals, at = new Date(), surface, className = "" }: TodaysDealsStripProps) {
  if (deals.length === 0) return null;

  const weekdayName = WEEKDAY_LABEL[weekdayOf(localDayDate(at, CITY.timezone))];

  return (
    <section className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center justify-between gap-2 px-1">
        <h3 className="text-headline-sm font-extrabold tracking-tight text-on-surface">
          Today&apos;s deals
          <span className="ml-1.5 font-semibold text-on-surface-variant">· {weekdayName}</span>
        </h3>
        <Link
          href="/deals"
          className="flex shrink-0 items-center gap-0.5 rounded-full bg-surface-container-lowest/80 px-2.5 py-1 text-label-sm font-semibold text-primary backdrop-blur-sm transition-opacity hover:opacity-80"
        >
          See all
          <Icon name="chevron_right" size={16} />
        </Link>
      </div>

      {/* lg: a vertical list in the right rail (first 5 only — "See all" covers the rest) instead of a horizontal scroller. */}
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:mx-0 lg:flex-col lg:gap-2.5 lg:overflow-visible lg:px-0 lg:pb-0 lg:[&>*:nth-child(n+6)]:hidden">
        {deals.map((item, i) =>
          item.kind === "group" ? (
            <TodaysDealGroupCard key={`group-${item.key}`} group={item} surface={surface} position={i} />
          ) : (
            <TodaysDealCard key={happeningKey(item.card)} card={item.card} surface={surface} position={i} />
          )
        )}
      </div>
    </section>
  );
}

function happeningKey(card: DealCardData): string {
  return `deal-${card.happening.id}`;
}

export default TodaysDealsStrip;
