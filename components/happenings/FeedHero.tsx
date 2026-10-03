"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, NavCard, SmartImage } from "@/components/ui";
import { formatEventDate, formatEventPrice, formatEventTimeSpan, formatEventWhen } from "@/lib/events/format";
import { categoryDefaultImage } from "@/lib/happenings/category-style";
import { HappeningHero } from "./HappeningHero";
import type { FeedHeroCard } from "@/lib/happenings/feed-types";
import type { EventItem } from "@/lib/types";
import { eventToPreview, prefetchEvent, setEventPreview } from "@/lib/events/preview-cache";
import { track, priceBand } from "@/lib/analytics/track";
import { tryOpenDetail } from "@/lib/detail-overlay/store";
import type { FeedCardSurface } from "./FeedListCard";

export interface FeedHeroProps {
  card: FeedHeroCard;
  /** Same meaning as HappeningHeroProps' own `variant` — only ever
   *  "book_early" on the Book Early tab, which only ever hands this a
   *  happening card (see app/api/feed/route.ts's `heroKind`), never an
   *  event one. */
  variant?: "fomo_pick" | "book_early";
  /** `card_opened`'s `surface` — this is always Home's hero slot, so callers pass "home_whats_on" (or "book_early" for the Book Early tab's own hero). */
  surface?: FeedCardSurface;
}

/**
 * The Home hero slot — a happening (delegates straight to HappeningHero,
 * unchanged presentation) or a free/cheap provider event (Skiddle/
 * Ticketmaster), which gets an equivalent hero treatment here since
 * HappeningHero's fields (promo code, redemption note, eligibility) don't
 * exist on an `EventItem`. Both variants carry the same `reason` eyebrow
 * pill from the recommendation score (lib/happenings/hero.ts).
 */
export function FeedHero({ card, variant = "fomo_pick", surface }: FeedHeroProps) {
  if (card.kind === "happening") {
    return (
      <HappeningHero
        happening={card.happening}
        occurrence={card.occurrence}
        variant={variant}
        reason={card.reason}
        surface={surface}
      />
    );
  }
  return <EventHero event={card.event} reason={card.reason} surface={surface} />;
}

function EventHero({ event, reason, surface }: { event: EventItem; reason: string | null; surface?: FeedCardSurface }) {
  const [imgError, setImgError] = useState(false);
  const router = useRouter();

  const price = formatEventPrice(event);
  const eventDate = formatEventDate(event.starts_at);
  const eventTime = formatEventTimeSpan(event.starts_at, event.ends_at);
  const heroImage = event.image_url && !imgError ? event.image_url : categoryDefaultImage(null);

  function trackOpen() {
    track("card_opened", { kind: "event", id: event.id, source: "event", surface, position: 0, price_band: priceBand(event.is_free) });
  }

  function goToEvent(e: React.MouseEvent | React.KeyboardEvent) {
    e.stopPropagation();
    // This button calls `stopPropagation`, so the click never reaches the
    // NavCard's own `onNavigate` below — write the preview here too, same
    // as that would have.
    setEventPreview(event.id, eventToPreview(event, { priceLabel: price, whenLabel: formatEventWhen(event.starts_at, event.ends_at) }));
    trackOpen();
    if (!tryOpenDetail(`/event/${event.id}`)) router.push(`/event/${event.id}`);
  }

  return (
    <NavCard
      href={`/event/${event.id}`}
      ariaLabel={event.name}
      onPointerDown={() => prefetchEvent(event.id)}
      onNavigate={() => {
        setEventPreview(event.id, eventToPreview(event, { priceLabel: price, whenLabel: formatEventWhen(event.starts_at, event.ends_at) }));
        trackOpen();
      }}
      className="relative flex flex-col overflow-hidden rounded-3xl bg-surface-container-lowest shadow-level-3 cursor-pointer lg:flex-row lg:transition-transform lg:hover:-translate-y-0.5"
    >
      <div className="relative h-32 w-full shrink-0 overflow-hidden bg-surface-container lg:h-auto lg:min-h-[260px] lg:w-[44%]">
        <SmartImage
          src={heroImage}
          alt=""
          width={480}
          height={128}
          sizes="(min-width: 1024px) 760px, (max-width: 480px) 100vw, 480px"
          priority
          className="h-full w-full object-cover lg:absolute lg:inset-0"
          onError={() => setImgError(true)}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-surface-container-lowest via-surface-container-lowest/15 to-transparent lg:from-black/55 lg:via-transparent" />

        <div className="absolute inset-x-3 top-3 flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col items-start gap-1">
            <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full bg-primary-container/90 px-3 py-1 text-label-sm font-bold text-on-primary-container backdrop-blur-md">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-secondary-fixed-dim animate-pulse" />
              <span className="min-w-0 truncate">Fomo Pick · {eventDate}</span>
            </span>
            {reason ? (
              <span className="block max-w-full truncate rounded-full bg-surface-container-lowest/85 px-2.5 py-0.5 text-label-sm font-semibold text-on-surface backdrop-blur-md">
                {reason}
              </span>
            ) : null}
          </div>
          {price ? (
            <span className="shrink-0 rounded-full border border-on-primary/20 bg-primary-container px-3 py-1 text-label-md font-bold text-on-primary-container shadow-md backdrop-blur-md">
              {price}
            </span>
          ) : null}
        </div>

        {event.venue_name ? (
          <div className="absolute bottom-2 left-3.5 right-3.5 flex min-w-0 items-center gap-1 text-primary lg:text-white">
            <Icon name="pin_drop" size={16} className="shrink-0" />
            <span className="min-w-0 truncate text-label-sm font-extrabold uppercase tracking-wider">{event.venue_name}</span>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2.5 p-3.5 pt-2.5 lg:min-w-0 lg:flex-1 lg:justify-between lg:gap-4 lg:p-6">
        <div className="flex flex-col gap-1">
          <h2 className="line-clamp-2 text-headline-sm font-extrabold leading-snug text-on-surface lg:line-clamp-3 lg:text-headline-md">{event.name}</h2>
          {event.description ? (
            <p className="line-clamp-1 text-body-sm text-on-surface-variant lg:line-clamp-3 lg:text-body-md">{event.description}</p>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-hairline pt-2.5">
          <span className="flex min-w-0 items-center gap-1 text-label-md font-medium text-on-surface-variant">
            <Icon name="schedule" size={15} className="shrink-0 text-secondary" />
            <span className="truncate">{eventTime}</span>
          </span>
          <button
            type="button"
            onClick={goToEvent}
            aria-label={`View event: ${event.name}`}
            className="flex h-9 shrink-0 items-center justify-center gap-0.5 rounded-full bg-primary pl-4 pr-3 text-label-lg font-bold text-on-primary shadow-sm transition-opacity hover:opacity-90 active:scale-95"
          >
            View
            <Icon name="chevron_right" size={18} />
          </button>
        </div>
      </div>
    </NavCard>
  );
}

export default FeedHero;
