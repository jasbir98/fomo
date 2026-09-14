"use client";

import { useState } from "react";
import { Icon, NavCard, SmartImage } from "@/components/ui";
import { formatEventPrice } from "@/lib/events/format";
import { savingBadgeLabel } from "@/lib/happenings/format";
import { categoryDefaultImage } from "@/lib/happenings/category-style";
import { NOTIFY_ME_ENABLED, type BookEarlyCardData } from "@/lib/happenings/book-early";
import { ensurePushSubscribed, pushReasonMessage } from "@/lib/push/client";
import { NotifyMeButton } from "./NotifyMeButton";

/** Leading thumbnail — same convention as FeedListCard's: the subject's own
 *  `image_url`, else a bundled per-category default. Larger than the list
 *  cards' 64px (task brief: bigger on Book Early / hero-adjacent cards). */
function Thumbnail({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-hairline bg-surface-container">
      <SmartImage src={src} alt={alt} width={80} height={80} className="h-full w-full object-cover" />
    </div>
  );
}

export interface BookEarlyCardProps {
  card: BookEarlyCardData;
  /** Whether the signed-in caller already has an on-sale alert for this
   *  happening — Home (app/(shell)/page.tsx) loads the caller's full alert
   *  list once via GET /api/alerts and passes each card's membership in so
   *  the button renders correctly subscribed on load instead of resetting
   *  to "Notify me" every refresh. Defaults to false for any other caller. */
  initialSubscribed?: boolean;
}

/** Small filled pill for the tier label ("Just on sale" / "Tickets open 1 Oct" / "On sale now") — same visual weight as FeedListCard's TypeTag, distinct component since Book Early's label is a full sentence fragment, not a short type tag. */
function TierPill({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-primary-container px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-on-primary-container">
      {label}
    </span>
  );
}

/**
 * One Book Early card — a happening or a cheap-events-adjacent Skiddle/
 * Ticketmaster event, both ranked/labelled by lib/happenings/book-early.ts.
 * Shares CardShell's visual chrome with FeedListCard's happening/event rows
 * (own copy rather than importing that module's unexported CardShell — this
 * card's body layout, and the Notify Me slot, differ enough that reusing the
 * exact same row markup would need more props threading than duplicating
 * the wrapper costs).
 */
export function BookEarlyCard({ card, initialSubscribed = false }: BookEarlyCardProps) {
  const [subscribed, setSubscribed] = useState(initialSubscribed);
  const [notifyError, setNotifyError] = useState<string | null>(null);

  /**
   * Ensures a live push subscription for this device, then records the
   * per-item alert (POST /api/alerts). Only ever called from
   * NotifyMeButton's onClick — `ensurePushSubscribed` requests Notification
   * permission the first time, which only works from a user gesture.
   */
  async function handleNotify(happeningId: string) {
    setNotifyError(null);
    const result = await ensurePushSubscribed();
    if (!result.ok) {
      setNotifyError(pushReasonMessage(result.reason) ?? "Couldn't turn on alerts — try again.");
      return;
    }
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ happeningId }),
      });
      if (!res.ok) throw new Error(`POST /api/alerts ${res.status}`);
      setSubscribed(true);
    } catch (err) {
      console.error("[book-early] create alert failed", err);
      setNotifyError("Couldn't turn on alerts — try again.");
    }
  }

  if (card.kind === "event") {
    const { event } = card;
    const price = formatEventPrice(event);
    const thumbnail = event.image_url ?? categoryDefaultImage(null);
    return (
      <NavCard
        href={`/event/${event.id}`}
        ariaLabel={event.name}
        className="flex cursor-pointer gap-3 rounded-2xl bg-surface-container-lowest p-4 shadow-level-1 transition-shadow hover:shadow-level-2"
      >
        <Thumbnail src={thumbnail} alt="" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <TierPill label={card.label} />
            {price ? <span className="shrink-0 text-label-sm font-extrabold text-primary">{price}</span> : null}
          </div>
          <h4 className="line-clamp-2 text-headline-sm font-bold leading-snug text-on-surface">{event.name}</h4>
          <span className="text-label-sm font-medium text-on-surface-variant">
            {card.dateLabel}
            {event.venue_name ? ` · ${event.venue_name}` : ""}
          </span>
          <a
            href={event.ticket_url ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-1 flex items-center justify-center gap-1 rounded-lg bg-primary py-2.5 text-label-md font-bold text-on-primary transition-opacity hover:opacity-90 active:scale-[0.98]"
          >
            Book now
            <Icon name="north_east" size={16} />
          </a>
        </div>
      </NavCard>
    );
  }

  const { happening } = card;
  const priceBadge = savingBadgeLabel(happening);
  const ctaHref = happening.booking_url ?? happening.source_url;
  const thumbnail = happening.image_url ?? categoryDefaultImage(happening.category);
  // tier 1 is exactly "booking_opens_at falls in the next 14 days" (see
  // lib/happenings/book-early.ts's bookEarlyTier) — reusing the
  // already-computed tier instead of re-deriving "is this in the future"
  // from `Date.now()` here keeps this component pure (no current-time read
  // during render) and gives one definition of "not open yet" instead of two.
  const bookingNotOpenYet = card.tier === 1;

  return (
    <NavCard
      href={`/happening/${happening.id}`}
      ariaLabel={happening.title}
      className="flex cursor-pointer gap-3 rounded-2xl bg-surface-container-lowest p-4 shadow-level-1 transition-shadow hover:shadow-level-2"
    >
      <Thumbnail src={thumbnail} alt="" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <TierPill label={card.label} />
            {/* Short derived urgency badge — replaces the raw `sellout_note`
                sentence this card used to print verbatim (still shown in full
                on the detail page's own Sells Fast section). */}
            {happening.sellout_risk === "high" ? (
              <span className="shrink-0 rounded-full bg-error-container px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-on-error-container">
                Sells fast
              </span>
            ) : null}
          </div>
          {priceBadge ? <span className="shrink-0 text-label-sm font-extrabold text-primary">{priceBadge}</span> : null}
        </div>
        <h4 className="line-clamp-2 text-headline-sm font-bold leading-snug text-on-surface">{happening.title}</h4>
        <span className="text-label-sm font-medium text-on-surface-variant">
          {card.dateLabel}
          {happening.venue_name ? ` · ${happening.venue_name}` : ""}
        </span>
        {card.sublabel ? <span className="text-label-sm font-semibold text-secondary">{card.sublabel}</span> : null}
        <div className="mt-1 flex items-center gap-2">
          <a
            href={ctaHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-primary py-2.5 text-label-md font-bold text-on-primary transition-opacity hover:opacity-90 active:scale-[0.98]"
          >
            Book now
            <Icon name="north_east" size={16} />
          </a>
          {NOTIFY_ME_ENABLED && bookingNotOpenYet ? (
            <NotifyMeButton subscribed={subscribed} onNotify={() => void handleNotify(happening.id)} />
          ) : null}
        </div>
        {notifyError ? <p className="text-label-sm text-error">{notifyError}</p> : null}
      </div>
    </NavCard>
  );
}

export default BookEarlyCard;
