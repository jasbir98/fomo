"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { buildAskFomoHref } from "@/lib/chat-seed";
import { buildSearchMapUrl, directionsUrlFor } from "@/lib/maps/links";
import { safeHttpUrl } from "@/lib/http/safe-url";
import { getEvent } from "@/lib/db";
import { useSaved } from "@/lib/useSaved";
import { eventDefaultImage, eventImageFor } from "@/lib/events/image";
import { formatEventPrice, formatEventWhen, isDateOnlyStart } from "@/lib/events/format";
import { buildEventFallbackDescription } from "@/lib/events/description";
import type { EventItem } from "@/lib/types";
import { Button, ErrorState, FomoLoader, Icon, PhotoCarousel, ShareButton, StatusPill } from "@/components/ui";
import type { CarouselPhoto } from "@/components/ui";
import { getEventPreview, takePrefetchedEvent, type EventPreview } from "@/lib/events/preview-cache";
import { track, trackOutboundClicked } from "@/lib/analytics/track";
import { FindBadge } from "@/components/finds/FindBadge";
import { useFind } from "@/lib/finds/useFinds";
import {
  ASIDE_CARD_CLASS,
  DETAIL_CONTENT_CLASS,
  DETAIL_CTA_BAR_CLASS,
  DETAIL_HERO_CLASS,
  DetailAside,
  DetailTopBar,
  detailGridClass,
  type DetailProps,
} from "./shared";

/** The preview cache never changes under a mounted page; nothing to subscribe to. */
const noopSubscribe = () => () => {};

/** "https://www.example.com/menu" -> "example.com" (the link text for the venue's website). */
function websiteHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Google Calendar "add event" link — mirrors the happening detail page's
 * own `googleCalendarUrl` (components/detail/HappeningDetail.tsx). Date-only
 * events (starts_at at midnight UTC) use all-day format (YYYYMMDD/YYYYMMDD+1);
 * timed events use the full timestamp format.
 */
function eventGoogleCalendarUrl(event: EventItem): string {
  const start = new Date(event.starts_at);

  if (isDateOnlyStart(event.starts_at)) {
    // All-day format: YYYYMMDD/YYYYMMDD (next day, exclusive end)
    const [year, month, day] = start.toISOString().slice(0, 10).split("-");
    const nextDay = new Date(start.getTime() + 86_400_000);
    const [nextYear, nextMonth, nextDay_str] = nextDay.toISOString().slice(0, 10).split("-");
    const dateStr = `${year}${month}${day}/${nextYear}${nextMonth}${nextDay_str}`;
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: event.name,
      dates: dateStr,
      details: [event.description, event.ticket_url].filter(Boolean).join("\n\n"),
      location: [event.venue_name, event.address].filter(Boolean).join(", ") || event.city || "Edinburgh",
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  const end = event.ends_at ? new Date(event.ends_at) : new Date(start.getTime() + 2 * 3_600_000);
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.name,
    dates: `${stamp(start)}/${stamp(end)}`,
    details: [event.description, event.ticket_url].filter(Boolean).join("\n\n"),
    location: [event.venue_name, event.address].filter(Boolean).join(", ") || event.city || "Edinburgh",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Event's own detail page (v1.1 W3) — mirrors app/(shell)/place/[id]/page.tsx's
 * data-fetching pattern, layout, and shared components (PageHeader,
 * PhotoCarousel, StatusPill), so every card that used to fetch-then-open a
 * sheet for an event now navigates here instead, exactly like a place card
 * navigates to /place/[id]. Fomo has no trips anymore — the secondary action
 * is a save/bookmark toggle (lib/useSaved.ts) instead of add-to-itinerary.
 */
export function EventDetail({ id, presentation = "page", initialEvent }: DetailProps & { initialEvent?: EventItem | null }) {
  const db = supabaseBrowserAuth();
  const pathname = usePathname();
  const { isSaved: checkSaved, toggle: toggleSaved } = useSaved();
  // On this week's hand-picked "For you" list? Drives the badge + "why" line at the top of the details card.
  const find = useFind("event", id);

  // `initialEvent` is what the server rendered for this route (app/(shell)/
  // event/[id]/page.tsx), so a shared link's first HTML already holds the
  // event. The overlay and in-app navigations don't pass it and load as
  // before. Either way the effect below still fetches a fresh copy.
  const [event, setEvent] = useState<EventItem | null>(initialEvent ?? null);
  const [loading, setLoading] = useState(!initialEvent);
  const hadInitialEvent = useRef(initialEvent != null);
  // True only after a real fetch failure — `getEvent` (lib/db/events.ts)
  // throws on an actual Supabase/network error and only ever resolves to
  // `null` for a genuine "no such row", so this stays reserved for the
  // former and never fires for the latter.
  const [error, setError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  // A card's click-time write to the preview cache, if there is one — powers
  // the instant hero while `loading` is still true; `null` means this page was
  // opened directly (a shared link, a fresh reload).
  // Read through useSyncExternalStore with a null server snapshot, not
  // useMemo: the cache falls back to sessionStorage, which the server can't
  // see, so a plain render-time read made a reload of an already-visited
  // detail page hydrate a different header than the server sent (a
  // hydration mismatch). During hydration React renders the server snapshot
  // (null, matching the HTML) and then re-renders with the cached preview;
  // on a client-side navigation there's no hydration, so the preview still
  // paints on the very first render. Keyed on `id` via the snapshot closure.
  const preview = useSyncExternalStore<EventPreview | null>(noopSubscribe, () => getEventPreview(id), () => null);

  useEffect(() => {
    let cancelled = false;
    // Reuses a card's early prefetch (started at pointerdown/touchstart,
    // see lib/events/preview-cache.ts) when one's in flight for this id,
    // instead of firing a second, redundant `getEvent` read.
    const prefetched = takePrefetchedEvent(id);
    (prefetched ?? getEvent(db, id))
      .then((data) => {
        if (!cancelled) {
          setEvent(data);
          setError(false);
        }
      })
      .catch((err) => {
        console.error("Failed to load event", err);
        // A failed refresh never replaces an event already on screen.
        if (!cancelled && !hadInitialEvent.current) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [db, id, reloadTick]);

  if (loading) {
    // No preview at all (a shared link opened directly, a fresh reload) —
    // nothing to paint yet, so the full-page mascot loader.
    if (!preview) {
      return (
        <>
          {presentation === "modal" ? <DetailTopBar presentation="modal" /> : null}
          <div className={`flex items-center justify-center ${presentation === "modal" ? "min-h-[360px]" : "min-h-dvh"}`}>
            <FomoLoader />
          </div>
        </>
      );
    }
    // A card already handed us the hero fields (see lib/events/
    // preview-cache.ts) — paint them immediately instead of a blank
    // full-page loader, with skeleton rows standing in for the rest
    // (description, When/Venue grid, directions, tickets — all of it needs
    // the real event row).
    const previewImage =
      preview.imageUrl ?? eventDefaultImage({ name: preview.title, venue_name: preview.venueName, category: preview.category ?? null });
    return (
      <div className="flex flex-col gap-4 pb-6">
        <DetailTopBar presentation={presentation} title={preview.title} />
        <div className={detailGridClass(presentation)}>
        <section className={DETAIL_HERO_CLASS}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewImage} alt="" className="h-full w-full object-cover" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-background/90 to-transparent" />
          <div className="absolute bottom-4 left-4 right-4 z-20 flex flex-wrap items-center gap-2">
            {preview.whenLabel ? <StatusPill label={preview.whenLabel} tone="info" icon="schedule" /> : null}
          </div>
        </section>
        <div className={DETAIL_CONTENT_CLASS}>
          <section className="rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-5 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span />
              {preview.priceLabel ? (
                <span className="text-label-md font-semibold text-primary">{preview.priceLabel}</span>
              ) : null}
            </div>
            {preview.venueName || preview.city ? (
              <p className="mb-1 text-label-md font-medium text-secondary">
                {[preview.venueName, preview.city].filter(Boolean).join(", ")}
              </p>
            ) : null}
            <h1 className="text-headline-lg font-extrabold leading-snug text-on-surface">{preview.title}</h1>
          </section>
          <div className="flex flex-col gap-3" role="status" aria-live="polite">
            <span className="sr-only">Loading the rest of this event…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-surface-container" />
            ))}
          </div>
        </div>
        <div
          aria-hidden="true"
          className="hidden h-56 animate-pulse rounded-2xl bg-surface-container lg:col-span-5 lg:col-start-8 lg:row-span-2 lg:row-start-1 lg:block"
        />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <DetailTopBar presentation={presentation} title="Event" />
        <div className="px-4 py-16">
          <ErrorState
            title="Couldn't load this event"
            message="Check your connection and try again."
            onRetry={() => setReloadTick((t) => t + 1)}
          />
        </div>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="flex flex-col gap-4">
        <DetailTopBar presentation={presentation} title="Event" />
        <div className="flex flex-col items-center gap-3 px-4 py-16 text-center text-on-surface-variant">
          <Icon name="event_busy" size={32} />
          <p className="text-body-md">We couldn&rsquo;t find this event.</p>
          <Link href="/whats-on" className="text-label-md font-medium text-secondary">
            Back to What&rsquo;s on
          </Link>
        </div>
      </div>
    );
  }

  const directionsUrl = directionsUrlFor({ lat: event.lat, lng: event.lng, query: event.address ?? event.venue_name ?? event.name });
  // ticket_url comes from Skiddle/Ticketmaster/JSON-LD scraping — validate
  // before it reaches an <a href> (see lib/http/safe-url.ts). A rejected
  // value falls through to the directions link, same as no ticket_url at all.
  const safeTicketUrl = safeHttpUrl(event.ticket_url);
  const price = formatEventPrice(event);
  // Event has a single image, no place_photos-style gallery: its own photo,
  // else the linked venue's, else the category tile (lib/events/image.ts), so
  // the hero is never the blank placeholder.
  const heroPhotos: CarouselPhoto[] = [{ url: eventImageFor(event), alt: event.name }];

  // Venue details: the event's own address (else the linked venue's), the
  // venue's website, and a Maps link — the venue's own Google Maps URL when we
  // have one, else a Maps search for venue + address (same helper the reels use).
  const venueAddress = event.address || event.place?.address || null;
  const venueWebsite = safeHttpUrl(event.place?.website);
  const venueWebsiteLabel = venueWebsite ? websiteHost(venueWebsite) : null;
  const mapsQuery = [event.venue_name, venueAddress].filter(Boolean).join(", ");
  const mapsCity = event.city || "Edinburgh";
  const mapsUrl =
    safeHttpUrl(event.place?.google_maps_uri) ??
    (mapsQuery ? buildSearchMapUrl(mapsQuery.toLowerCase().includes(mapsCity.toLowerCase()) ? mapsQuery : `${mapsQuery}, ${mapsCity}`) : null);
  // App isn't deployed yet — window.location.origin is the correct base for
  // a shareable link until there's a real production host.
  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}${pathname}` : "";
  const shareText = `${[event.name, formatEventWhen(event.starts_at, event.ends_at), price]
    .filter(Boolean)
    .join(" · ")} · via Fomo`;

  // The location tile renders twice: in the left column (hidden at lg) and in
  // the desktop aside (hidden below lg). No effects or mount-time tracking in
  // it — only a click-time `trackOutboundClicked` — so the duplicate is free.
  const mapCard = (cls: string) => (
    <section className={cls}>
          <h2 className="mb-4 text-headline-sm text-primary">Location</h2>
          {directionsUrl ? (
            <a
              href={directionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackOutboundClicked("event", event.id, directionsUrl, "directions")}
              className="relative flex h-40 w-full overflow-hidden rounded-xl border border-outline-variant/40 bg-surface-container text-left"
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <Icon name="map" size={64} className="text-outline-variant" />
              </div>
              <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2 rounded-lg bg-white/90 px-3 py-2 backdrop-blur-md">
                <div className="min-w-0">
                  <p className="truncate text-label-md text-primary">
                    {event.venue_name ?? event.address ?? event.name}
                  </p>
                  <p className="text-label-sm text-on-surface-variant">Tap to open directions</p>
                </div>
                <Icon name="open_in_new" className="shrink-0 text-primary" />
              </div>
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="relative h-40 w-full overflow-hidden rounded-xl border border-outline-variant/40 bg-surface-container text-left disabled:pointer-events-none disabled:opacity-60"
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <Icon name="map" size={64} className="text-outline-variant" />
              </div>
              <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2 rounded-lg bg-white/90 px-3 py-2 backdrop-blur-md">
                <div className="min-w-0">
                  <p className="truncate text-label-md text-primary">
                    {event.venue_name ?? event.address ?? event.name}
                  </p>
                  <p className="text-label-sm text-on-surface-variant">Location unavailable</p>
                </div>
              </div>
            </button>
          )}
        </section>
  );

  return (
    <div className="flex flex-col gap-4 pb-6">
      <DetailTopBar
        presentation={presentation}
        title={event.name}
        action={<ShareButton title={event.name} text={shareText} url={shareUrl} kind="event" />}
      />

      <div className={detailGridClass(presentation)}>
      {/* Hero */}
      <section className={DETAIL_HERO_CLASS}>
        <PhotoCarousel key={event.id} photos={heroPhotos} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-background/90 to-transparent" />
        <div className="absolute bottom-4 left-4 right-4 z-20 flex">
          <StatusPill label={formatEventWhen(event.starts_at, event.ends_at)} tone="info" icon="schedule" />
        </div>
      </section>

      <div className={DETAIL_CONTENT_CLASS}>
        {/* Retired events (supabase/add_event_lifecycle.sql) stay reachable from
            saved items and shared links, so say plainly that they're over. */}
        {event.status === "cancelled" ? (
          <div role="status" className="flex items-start gap-2.5 rounded-2xl bg-error-container/40 p-3.5 text-on-surface">
            <Icon name="event_busy" size={20} className="mt-0.5 shrink-0 text-error" />
            <p className="text-body-md">
              <span className="font-bold">Cancelled.</span> The organiser has cancelled or postponed this. Check the
              official page for new dates.
            </p>
          </div>
        ) : event.status === "expired" || event.status === "gone" ? (
          <div role="status" className="flex items-start gap-2.5 rounded-2xl bg-error-container/40 p-3.5 text-on-surface">
            <Icon name="event_busy" size={20} className="mt-0.5 shrink-0 text-error" />
            <p className="text-body-md">
              <span className="font-bold">This has finished.</span>{" "}
              {event.status === "gone"
                ? "It's no longer listed by the organiser. Check the official page before you go."
                : "It's no longer running. Check the official page before you go."}
            </p>
          </div>
        ) : null}

        {/* Description & stats */}
        <section className="rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-5 shadow-sm">
          {find ? <FindBadge why={find.why} className="mb-3" /> : null}
          <div className="mb-3 flex items-center justify-between gap-3">
            {event.category ? (
              <span className="rounded-full bg-surface-container-low px-3 py-1 text-label-sm capitalize text-on-surface-variant">
                {event.category}
              </span>
            ) : (
              <span />
            )}
            {price ? <span className="text-label-md font-semibold text-primary">{price}</span> : null}
          </div>
          {event.venue_name || event.city ? (
            <p className="mb-1 text-label-md font-medium text-secondary">
              {[event.venue_name, event.city].filter(Boolean).join(", ")}
            </p>
          ) : null}
          {/* No usable description from the source (already null after
              lib/db/events.ts's placeholder cleaning): a plain factual line
              built only from fields we hold, styled slightly muted. */}
          {event.description ? (
            <p className="mb-4 text-body-md text-on-surface-variant">{event.description}</p>
          ) : (
            <p className="mb-4 text-body-md text-on-surface-variant/80">{buildEventFallbackDescription(event)}</p>
          )}
          {/* Licence duty (api.edinburghfestivalcity.com/licence): festival-sourced
              listings must credit the API and say this is not an official festival app. */}
          {event.provider === "edfestivals" ? (
            <p className="mb-4 text-label-sm text-on-surface-variant/80">
              Data courtesy of the{" "}
              <a
                href="https://api.edinburghfestivalcity.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline-offset-2 hover:underline"
              >
                Edinburgh Festivals Listings API
              </a>{" "}
              &middot; Fomo is not an official festival app
            </p>
          ) : null}
          {venueAddress || mapsUrl || venueWebsiteLabel ? (
            <ul className="mb-4 flex flex-col gap-2.5 border-t border-outline-variant/30 pt-4">
              {venueAddress ? (
                <li className="flex items-start gap-3">
                  <Icon name="location_on" className="mt-0.5 text-primary" />
                  <span className="text-label-md text-on-surface">{venueAddress}</span>
                </li>
              ) : null}
              {mapsUrl ? (
                <li className="flex items-start gap-3">
                  <Icon name="map" className="mt-0.5 text-primary" />
                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => trackOutboundClicked("event", event.id, mapsUrl, "maps")}
                    className="text-label-md text-secondary underline underline-offset-2"
                  >
                    Open in Google Maps
                  </a>
                </li>
              ) : null}
              {venueWebsite && venueWebsiteLabel ? (
                <li className="flex items-start gap-3">
                  <Icon name="language" className="mt-0.5 text-primary" />
                  <a
                    href={venueWebsite}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => trackOutboundClicked("event", event.id, venueWebsite, "website")}
                    className="text-label-md text-secondary underline underline-offset-2"
                  >
                    {venueWebsiteLabel}
                  </a>
                </li>
              ) : null}
            </ul>
          ) : null}
          <div className="grid grid-cols-2 gap-4 border-t border-outline-variant/30 pt-4 lg:hidden">
            <div className="flex items-center gap-3">
              <Icon name="schedule" className="text-primary" />
              <div>
                <p className="text-label-sm text-on-surface-variant">When</p>
                <p className="text-label-md text-on-surface">
                  {formatEventWhen(event.starts_at, event.ends_at)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Icon name="location_on" className="text-primary" />
              <div>
                <p className="text-label-sm text-on-surface-variant">Venue</p>
                <p className="text-label-md text-on-surface">
                  {event.venue_name ?? event.address ?? "–"}
                </p>
              </div>
            </div>
          </div>

          {/* Add to calendar — same pattern as the happening detail page's
              own "When" section: primary is the .ics route (a plain <a
              href>, no target="_blank", so iOS Safari opens the native Add
              Event sheet instead of a new tab), Google Calendar's web link
              stays as a secondary option. */}
          <div className="flex items-center gap-2 border-t border-outline-variant/30 pt-4 lg:hidden">
            <a
              href={`/api/events/${event.id}/ics`}
              onClick={() => track("calendar_added", { type: "ics", kind: "event" })}
              className="flex min-h-10 items-center gap-1 rounded-full border border-hairline-strong px-3 text-label-sm font-bold text-primary hover:bg-surface-container"
            >
              <Icon name="event_available" size={16} />
              Add to calendar
            </a>
            <a
              href={eventGoogleCalendarUrl(event)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track("calendar_added", { type: "google", kind: "event" })}
              className="text-label-sm font-medium text-on-surface-variant underline-offset-2 hover:underline"
            >
              Google Calendar
            </a>
          </div>
        </section>

        {mapCard("lg:hidden")}
      </div>

      {/* Aside. Below lg this is `display: contents`: the actions bar is a
          plain sticky-bottom flex child of the page exactly as before, and the
          `hidden lg:block` cards stay hidden. At lg it is the sticky right
          column — price/when/venue/calendar, the same single actions group
          (static there), and the location tile. */}
      <DetailAside presentation={presentation}>
      <section className={ASIDE_CARD_CLASS}>
        <div className="flex flex-col gap-4">
          {price ? <p className="text-headline-md font-extrabold text-primary">{price}</p> : null}
          <div className="grid grid-cols-1 gap-4">
            <div className="flex items-center gap-3">
              <Icon name="schedule" className="text-primary" />
              <div>
                <p className="text-label-sm text-on-surface-variant">When</p>
                <p className="text-label-md text-on-surface">
                  {formatEventWhen(event.starts_at, event.ends_at)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Icon name="location_on" className="text-primary" />
              <div>
                <p className="text-label-sm text-on-surface-variant">Venue</p>
                <p className="text-label-md text-on-surface">
                  {event.venue_name ?? event.address ?? "–"}
                </p>
              </div>
            </div>
          </div>

          {/* Add to calendar — same pattern as the happening detail page's
              own "When" section: primary is the .ics route (a plain <a
              href>, no target="_blank", so iOS Safari opens the native Add
              Event sheet instead of a new tab), Google Calendar's web link
              stays as a secondary option. */}
          <div className="flex items-center gap-2 border-t border-outline-variant/30 pt-4">
            <a
              href={`/api/events/${event.id}/ics`}
              onClick={() => track("calendar_added", { type: "ics", kind: "event" })}
              className="flex min-h-10 items-center gap-1 rounded-full border border-hairline-strong px-3 text-label-sm font-bold text-primary hover:bg-surface-container"
            >
              <Icon name="event_available" size={16} />
              Add to calendar
            </a>
            <a
              href={eventGoogleCalendarUrl(event)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track("calendar_added", { type: "google", kind: "event" })}
              className="text-label-sm font-medium text-on-surface-variant underline-offset-2 hover:underline"
            >
              Google Calendar
            </a>
          </div>
        </div>
      </section>

      <div className={DETAIL_CTA_BAR_CLASS}>
        <div className="flex gap-3">
          {safeTicketUrl ? (
            <a
              href={safeTicketUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackOutboundClicked("event", event.id, safeTicketUrl, "get_tickets")}
              className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl bg-secondary-container px-4 text-label-md font-semibold text-on-secondary-container shadow-sm transition-opacity hover:opacity-90"
            >
              <Icon name="confirmation_number" size={18} />
              Get tickets
            </a>
          ) : directionsUrl ? (
            <a
              href={directionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackOutboundClicked("event", event.id, directionsUrl, "directions")}
              className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-secondary-container px-6 text-label-md font-medium text-on-secondary-container shadow-sm transition-all hover:opacity-90 active:opacity-80"
            >
              <Icon name="directions" size={18} />
              Get Directions
            </a>
          ) : (
            <Button
              variant="orange"
              fullWidth
              leadingIcon="directions"
              disabled
            >
              Get Directions
            </Button>
          )}
          <Link
            href={buildAskFomoHref({
              type: "event",
              id,
              name: event.name,
              coords: event.lat != null && event.lng != null ? { lat: event.lat, lng: event.lng } : null,
              returnTo: pathname,
            })}
            aria-label="Ask Fomo about this event"
            className="flex min-h-[48px] items-center justify-center rounded-xl border-[1.5px] border-primary px-4 text-primary transition-colors hover:bg-primary/5 active:bg-primary/10"
          >
            <Icon name="chat" size={20} />
          </Link>
          <Button
            variant={checkSaved("event", id) ? "danger" : "outline"}
            leadingIcon={checkSaved("event", id) ? "bookmark" : "bookmark_border"}
            onClick={() => void toggleSaved("event", id)}
          >
            {checkSaved("event", id) ? "Saved" : "Save"}
          </Button>
        </div>
      </div>

      {mapCard("hidden lg:block")}
      </DetailAside>
      </div>
    </div>
  );
}
