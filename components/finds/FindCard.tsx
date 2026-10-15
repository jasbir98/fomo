"use client";

import { useSyncExternalStore } from "react";
import { Icon, NavCard, SaveButton, SmartImage } from "@/components/ui";
import { PriceTag } from "@/components/happenings/PriceTag";
import { FomoLevel } from "@/components/finds/FomoLevel";
import { occurrenceWhenLabel } from "@/components/happenings/FeedListCard";
import { eventIsInProgress, eventDateLabel, formatEventPrice, formatEventTimeSpan, formatEventWhen } from "@/lib/events/format";
import { eventImageFor } from "@/lib/events/image";
import { eventToPreview, prefetchEvent, setEventPreview } from "@/lib/events/preview-cache";
import { defaultImageFor } from "@/lib/happenings/category-style";
import { eventOnNowLabel, occurrenceRangeLabel, savingBadgeLabel } from "@/lib/happenings/format";
import { nextOccurrence, normalizeRecurrence } from "@/lib/happenings/occurrence";
import { happeningToPreview, prefetchHappening, setHappeningPreview } from "@/lib/happenings/preview-cache";
import { priceLabelForEvent, priceLabelForHappening } from "@/lib/happenings/price-label";
import { interestForHappeningCategory } from "@/lib/personalise/interests";
import { track } from "@/lib/analytics/track";
import type { FindItem } from "@/lib/finds/types";

/**
 * One time read per page load, client-only: the server snapshot is `null`, so
 * the "when" line (which depends on today's date) is left out of the server
 * HTML and the first hydration pass, then appears. Rendering it straight from
 * `new Date()` would let a cached /for-you page (revalidate 120s) disagree with
 * the client at a day boundary and warn about a hydration mismatch.
 */
let clientNow: Date | null = null;
const noopSubscribe = () => () => {};
function useClientNow(): Date | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => (clientNow ??= new Date()),
    () => null
  );
}

export interface FindCardProps {
  item: FindItem;
  /** Why this visitor is seeing it ("You're into Comedy"), from lib/personalise/for-you.ts. Omit for none. */
  reason?: string | null;
  /** 0-based index within the list, sent with `find_opened`. */
  position?: number;
  /** Where the card is mounted, sent with `find_opened`. */
  surface?: string;
}

/**
 * One hand-picked pick on the "For you" tab (components/finds; the same picks
 * run on Instagram as "Fomo Finds"): an image-led card with the price, what and
 * where, the one-line "why it's a steal", and the Fomo level meter.
 *
 * Opens the normal detail page through NavCard, the same way FeedListCard and
 * BookEarlyCard do, so on desktop it goes through the detail overlay's
 * pushState modal (`tryOpenDetail`) and on a phone is an ordinary push. It is a
 * NavCard rather than a wrapping link because it holds a real button (the
 * bookmark); see components/ui/NavCard.tsx. All text/price/date formatting
 * comes from the same helpers the feed cards use. It never shows the "Picked
 * for you" badge, since every card on this list already is one.
 */
export function FindCard({ item, reason = null, position, surface = "for_you" }: FindCardProps) {
  const now = useClientNow();

  if (item.kind === "event") {
    const { event } = item;
    const when = now
      ? eventIsInProgress(event, now)
        ? eventOnNowLabel(event.ends_at, now)
        : [eventDateLabel(event, now), formatEventTimeSpan(event.starts_at, event.ends_at)].filter(Boolean).join(" · ")
      : null;
    return (
      <Shell
        href={`/event/${event.id}`}
        title={event.name}
        image={eventImageFor(event)}
        price={<PriceTag label={priceLabelForEvent(event)} variant="banner" />}
        when={when}
        venue={event.venue_name}
        item={item}
        reason={reason}
        save={<SaveButton subjectType="event" subjectId={event.id} compact className="-my-1 -mr-2" />}
        onPointerDown={() => prefetchEvent(event.id)}
        onNavigate={() => {
          setEventPreview(
            event.id,
            eventToPreview(event, { priceLabel: formatEventPrice(event), whenLabel: formatEventWhen(event.starts_at, event.ends_at) })
          );
          track("find_opened", { kind: "event", id: event.id, position, surface });
        }}
      />
    );
  }

  const { happening } = item;
  const occurrence = now ? nextOccurrence(happening, now, new Date(now.getTime() + 366 * 86_400_000)) : null;
  // A standing deal ("always") has no date to show; "Today" would be wrong.
  const standing = normalizeRecurrence(happening.recurrence).type === "always";
  const when = !now ? null : standing ? "Any time" : occurrence ? occurrenceWhenLabel(occurrence, now) : null;
  return (
    <Shell
      href={`/happening/${happening.id}`}
      title={happening.title}
      image={happening.image_url ?? defaultImageFor(happening)}
      price={<PriceTag label={priceLabelForHappening(happening)} variant="banner" />}
      when={when}
      venue={happening.venue_name ?? happening.district}
      item={item}
      reason={reason}
      save={
        <SaveButton
          subjectType="happening"
          subjectId={happening.id}
          interestHint={interestForHappeningCategory(happening.category)}
          compact
          className="-my-1 -mr-2"
        />
      }
      onPointerDown={() => prefetchHappening(happening.id)}
      onNavigate={() => {
        setHappeningPreview(
          happening.id,
          happeningToPreview(happening, {
            priceLabel: savingBadgeLabel(happening),
            whenLabel: occurrence ? occurrenceRangeLabel(occurrence) : null,
          })
        );
        track("find_opened", { kind: "happening", id: happening.id, position, surface });
      }}
    />
  );
}

function Shell({
  href,
  title,
  image,
  price,
  when,
  venue,
  item,
  reason,
  save,
  onPointerDown,
  onNavigate,
}: {
  href: string;
  title: string;
  image: string;
  price: React.ReactNode;
  when: string | null;
  venue: string | null;
  item: FindItem;
  reason: string | null;
  save: React.ReactNode;
  onPointerDown: () => void;
  onNavigate: () => void;
}) {
  const meta = [when, venue].filter(Boolean).join(" · ");
  return (
    <NavCard
      href={href}
      ariaLabel={title}
      onPointerDown={onPointerDown}
      onNavigate={onNavigate}
      className="flex h-full cursor-pointer flex-col overflow-hidden rounded-2xl bg-surface-container-lowest shadow-level-1 transition-shadow hover:shadow-level-2"
    >
      <div className="relative">
        <SmartImage
          src={image}
          alt=""
          width={480}
          height={176}
          sizes="(min-width: 1280px) 380px, (min-width: 1024px) 45vw, (max-width: 480px) 100vw, 480px"
          className="h-44 w-full object-cover"
        />
        <div className="absolute right-3 top-3">{price}</div>
      </div>
      {/* flex-1 + the footer's mt-auto: in a grid row every card is as tall
          as the tallest, and the Fomo level row lines up along the bottom. */}
      <div className="flex flex-1 flex-col gap-2 p-3.5">
        {reason ? (
          <span className="inline-flex w-fit max-w-full items-center gap-1 rounded-full bg-secondary-container/25 px-2 py-0.5 text-label-sm font-bold text-primary">
            <Icon name="auto_awesome" filled size={12} className="shrink-0" />
            <span className="truncate">{reason}</span>
          </span>
        ) : null}
        <div className="flex flex-col gap-0.5">
          <h3 className="line-clamp-2 text-headline-sm font-bold leading-snug text-on-surface">{title}</h3>
          {meta ? <p className="truncate text-label-md font-medium text-on-surface-variant">{meta}</p> : null}
        </div>
        <p className="line-clamp-3 text-body-md font-semibold leading-snug text-on-surface">{item.why}</p>
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <FomoLevel level={item.fomoLevel} />
          <div className="shrink-0">{save}</div>
        </div>
      </div>
    </NavCard>
  );
}

export default FindCard;
