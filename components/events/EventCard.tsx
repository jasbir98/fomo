"use client";

import { Chip, Icon } from "@/components/ui";
import type { EventItem } from "@/lib/types";
import { formatEventPrice, formatEventWhen } from "@/lib/events/format";
import { formatDistanceLabel } from "@/lib/geo";

export type EventCardVariant = "carousel" | "list";

export type EventCardProps = {
  event: EventItem;
  /** "carousel" (220px, Home strip) or "list" (full-width row, /events). */
  variant?: EventCardVariant;
  /** Distance in km from the device's live location, when available — the
   * caller (Home / /events) computes this via lib/geo.ts's distanceKm(). */
  distanceKm?: number | null;
  onClick?: () => void;
};

/**
 * The app's first extracted feed card — everything else (Home, Map, reels)
 * still inlines its card JSX. The card root is a `<div role="button">`
 * rather than a real `<button>`/`<Link>` because it contains a `Chip`
 * (itself a `<button>`) for the category — nesting interactive controls
 * inside a `<button>`/`<a>` is invalid HTML, but a `<div>` wrapping a
 * `<button>` is fine.
 */
export function EventCard({ event, variant = "carousel", distanceKm, onClick }: EventCardProps) {
  const when = formatEventWhen(event.starts_at, event.ends_at);
  const price = formatEventPrice(event);
  const distanceLabel = distanceKm != null ? formatDistanceLabel(distanceKm) : null;
  const subLabel = [event.venue_name, distanceLabel].filter(Boolean).join(" • ");

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick?.();
    }
  }

  const image = (
    // Width must be variant-specific, not `w-full` plus a `w-20` override:
    // Tailwind emits both utilities and the cascade (not the class order here)
    // picks the winner, so `w-full` beat `w-20` and the list thumbnail grew to
    // fill the row, pushing the text column off-screen.
    <div
      className={`relative shrink-0 overflow-hidden bg-surface-container ${
        variant === "list" ? "h-20 w-20 rounded-lg" : "h-[140px] w-full"
      }`}
    >
      {event.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={event.image_url}
          alt={event.name}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Icon name="event" className="text-outline" />
        </div>
      )}
    </div>
  );

  const meta = (
    <div className="flex items-center gap-2">
      {event.category ? (
        <Chip label={event.category} className="pointer-events-none min-h-[28px] px-3 text-[11px] capitalize" />
      ) : null}
      {price ? <span className="text-label-sm font-semibold text-primary">{price}</span> : null}
    </div>
  );

  if (variant === "list") {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={handleKeyDown}
        className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-outline-variant/60 bg-surface-container-lowest p-3 text-left shadow-sm transition-shadow hover:shadow-md"
      >
        {image}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-label-sm text-on-surface-variant">{when}</p>
          <h3 className="text-headline-sm text-on-surface line-clamp-2">{event.name}</h3>
          {subLabel ? (
            <p className="truncate text-label-sm text-on-surface-variant">{subLabel}</p>
          ) : null}
          {meta}
        </div>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className="flex w-[220px] shrink-0 cursor-pointer snap-start flex-col overflow-hidden rounded-lg border border-outline-variant/60 bg-surface-container-lowest text-left shadow-sm transition-shadow hover:shadow-md"
    >
      {image}
      <div className="flex flex-col gap-1 p-3">
        <p className="text-label-sm text-on-surface-variant">{when}</p>
        <h3 className="text-headline-sm text-on-surface line-clamp-2">{event.name}</h3>
        {subLabel ? (
          <p className="truncate text-label-sm text-on-surface-variant">{subLabel}</p>
        ) : null}
        {meta}
      </div>
    </div>
  );
}

export default EventCard;
