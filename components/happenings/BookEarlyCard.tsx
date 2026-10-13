"use client";

import { useState } from "react";
import { Icon, NavCard, SaveButton, SmartImage } from "@/components/ui";
import { formatEventPrice } from "@/lib/events/format";
import { savingBadgeLabel } from "@/lib/happenings/format";
import { defaultImageFor } from "@/lib/happenings/category-style";
import { NOTIFY_ME_ENABLED, type BookEarlyCardData } from "@/lib/happenings/book-early";
import { ensurePushSubscribed, pushReasonMessage } from "@/lib/push/client";
import { useSignedIn } from "@/lib/useSaved";
import { sendToSignIn } from "@/lib/auth/send-to-signin";
import { NotifyMeButton } from "./NotifyMeButton";
import { happeningToPreview, prefetchHappening, setHappeningPreview } from "@/lib/happenings/preview-cache";
import { eventToPreview, prefetchEvent, setEventPreview } from "@/lib/events/preview-cache";
import { eventImageFor } from "@/lib/events/image";
import { track, priceBand, trackOutboundClicked } from "@/lib/analytics/track";
import { FindBadge } from "@/components/finds/FindBadge";
import { useFind } from "@/lib/finds/useFinds";

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
   *  list once via GET /api/alerts (signed in only) and passes each card's membership in so
   *  the button renders correctly subscribed on load instead of resetting
   *  to "Notify me" every refresh. Defaults to false for any other caller. */
  initialSubscribed?: boolean;
  /** 0-based index within its list — `card_opened`'s `position`. `surface` is always "book_early" (Home's Book early tab and the dedicated /book-early page both render this same card), so it isn't a prop. */
  position?: number;
}

/** Small filled pill for the tier label ("Just on sale" / "Tickets open 1 Oct" / "On sale now") — same visual weight as FeedListCard's TypeTag, distinct component since Book Early's label is a full sentence fragment, not a short type tag. */
function TierPill({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-primary-container px-2.5 py-0.5 text-label-sm font-bold uppercase tracking-wide text-on-primary-container">
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
export function BookEarlyCard({ card, initialSubscribed = false, position }: BookEarlyCardProps) {
  const [subscribed, setSubscribed] = useState(initialSubscribed);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const signedIn = useSignedIn();
  // Hand-picked "For you" item? Gets a "Picked for you" pill on its own line at
  // the top of the card body (the tier/price/save row above the title is
  // already full on a 480px phone, so it doesn't share that row).
  const find = useFind(card.kind === "event" ? "event" : "happening", card.kind === "event" ? card.event.id : card.happening.id);

  /**
   * Ensures a live push subscription for this device, then records the
   * per-item alert (POST /api/alerts). Only ever called from
   * NotifyMeButton's onClick — `ensurePushSubscribed` requests Notification
   * permission the first time, which only works from a user gesture.
   * Alerts need an account, so a signed-out tap goes to sign-in first,
   * before any permission prompt or request.
   */
  async function handleNotify(happeningId: string) {
    setNotifyError(null);
    if (signedIn === false) {
      sendToSignIn("notify");
      return;
    }
    const result = await ensurePushSubscribed();
    if (!result.ok) {
      setNotifyError(pushReasonMessage(result.reason) ?? "Couldn't turn on alerts. Try again.");
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
      setNotifyError("Couldn't turn on alerts. Try again.");
    }
  }

  async function handleUnnotify(happeningId: string) {
    setNotifyError(null);
    try {
      const res = await fetch("/api/alerts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ happeningId }),
      });
      if (!res.ok) throw new Error(`DELETE /api/alerts ${res.status}`);
      setSubscribed(false);
    } catch (err) {
      console.error("[book-early] remove alert failed", err);
      setNotifyError("Couldn't turn off the alert. Try again.");
    }
  }

  if (card.kind === "event") {
    const { event } = card;
    const price = formatEventPrice(event);
    const thumbnail = eventImageFor(event);
    return (
      <NavCard
        href={`/event/${event.id}`}
        ariaLabel={event.name}
        onPointerDown={() => prefetchEvent(event.id)}
        onNavigate={() => {
          setEventPreview(event.id, eventToPreview(event, { priceLabel: price, whenLabel: card.dateLabel }));
          track("card_opened", { kind: "event", id: event.id, source: "event", surface: "book_early", position, price_band: priceBand(event.is_free) });
        }}
        className="flex cursor-pointer gap-3 rounded-2xl bg-surface-container-lowest p-3.5 shadow-level-1 transition-shadow hover:shadow-level-2"
      >
        <Thumbnail src={thumbnail} alt="" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {find ? <FindBadge className="self-start" /> : null}
          <div className="flex items-center justify-between gap-2">
            <TierPill label={card.label} />
            <div className="flex items-center gap-2">
              {price ? <span className="shrink-0 text-label-sm font-extrabold text-primary">{price}</span> : null}
              <SaveButton subjectType="event" subjectId={event.id} className="-my-2 -mr-2" />
            </div>
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
            onClick={(e) => {
              e.stopPropagation();
              trackOutboundClicked("event", event.id, event.ticket_url, "get_tickets");
            }}
            className="mt-1 flex items-center justify-center gap-1 rounded-lg bg-primary py-2.5 text-label-md font-bold text-on-primary transition-opacity hover:opacity-90 active:scale-[0.98]"
          >
            Get tickets
            <Icon name="north_east" size={16} />
          </a>
        </div>
      </NavCard>
    );
  }

  const { happening } = card;
  const priceBadge = savingBadgeLabel(happening);
  const ctaHref = happening.booking_url ?? happening.source_url;
  const thumbnail = happening.image_url ?? defaultImageFor(happening);
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
      onPointerDown={() => prefetchHappening(happening.id)}
      onNavigate={() => {
        setHappeningPreview(happening.id, happeningToPreview(happening, { priceLabel: priceBadge, whenLabel: card.dateLabel }));
        track("card_opened", { kind: "happening", id: happening.id, source: happening.kind, surface: "book_early", position, price_band: priceBand(happening.is_free) });
      }}
      className="flex cursor-pointer gap-3 rounded-2xl bg-surface-container-lowest p-3.5 shadow-level-1 transition-shadow hover:shadow-level-2"
    >
      <Thumbnail src={thumbnail} alt="" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {find ? <FindBadge className="self-start" /> : null}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <TierPill label={card.label} />
            {/* Short derived urgency badge — replaces the raw `sellout_note`
                sentence this card used to print verbatim (still shown in full
                on the detail page's own Sells Fast section). */}
            {happening.sellout_risk === "high" ? (
              <span className="shrink-0 rounded-full bg-error-container px-2 py-0.5 text-label-sm font-bold uppercase tracking-wide text-on-error-container">
                Sells fast
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {priceBadge ? <span className="shrink-0 text-label-sm font-extrabold text-primary">{priceBadge}</span> : null}
            <SaveButton subjectType="happening" subjectId={happening.id} className="-my-2 -mr-2" />
          </div>
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
            onClick={(e) => {
              e.stopPropagation();
              trackOutboundClicked("happening", happening.id, ctaHref, "get_tickets");
            }}
            className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-primary py-2.5 text-label-md font-bold text-on-primary transition-opacity hover:opacity-90 active:scale-[0.98]"
          >
            Get tickets
            <Icon name="north_east" size={16} />
          </a>
          {NOTIFY_ME_ENABLED && bookingNotOpenYet ? (
            <NotifyMeButton
              subscribed={subscribed}
              onNotify={() => void handleNotify(happening.id)}
              onUnnotify={() => void handleUnnotify(happening.id)}
            />
          ) : null}
        </div>
        {notifyError ? <p className="text-label-sm text-error">{notifyError}</p> : null}
      </div>
    </NavCard>
  );
}

export default BookEarlyCard;
