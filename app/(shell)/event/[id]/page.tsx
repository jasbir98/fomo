"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useDeviceId } from "@/lib/device";
import { buildAskRoameoHref } from "@/lib/chat-seed";
import { getEvent, getCurrentTrip, createItem, deleteItem, listItems } from "@/lib/db";
import {
  eventDayDate,
  formatEventPrice,
  formatEventTime,
  formatEventWhen,
} from "@/lib/events/format";
import type { EventItem } from "@/lib/types";
import { Button, Icon, PageHeader, PhotoCarousel, StatusPill } from "@/components/ui";
import type { CarouselPhoto } from "@/components/ui";

type AddState = "idle" | "adding" | "added" | "removing" | "error";

/** Same lat/lng-first, address-fallback shape as lib/maps/links.ts's
 * buildDirectionsUrl for Place — Event has no google_place_id, so no
 * disambiguation param. */
function eventDirectionsUrl(event: EventItem): string | null {
  if (event.lat != null && event.lng != null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${event.lat},${event.lng}`;
  }
  const fallback = event.address ?? event.venue_name ?? event.name;
  if (!fallback) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fallback)}`;
}

/**
 * Event's own detail page (v1.1 W3) — mirrors app/(shell)/place/[id]/page.tsx's
 * data-fetching pattern, layout, and shared components (PageHeader,
 * PhotoCarousel, StatusPill), so every card that used to fetch-then-open a
 * sheet for an event now navigates here instead, exactly like a place card
 * navigates to /place/[id]. The add-to-trip machinery (including the
 * outside-trip-dates guard) is carried over from the retired
 * components/events/EventDetailSheet.tsx, since an event — unlike a place —
 * has a fixed date that can fall outside the trip's start/end window.
 */
export default function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const deviceId = useDeviceId();
  const router = useRouter();
  const pathname = usePathname();

  const [event, setEvent] = useState<EventItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [tripStartDate, setTripStartDate] = useState<string | null>(null);
  const [tripEndDate, setTripEndDate] = useState<string | null>(null);
  const [addState, setAddState] = useState<AddState>("idle");
  const [itemId, setItemId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getEvent(id)
      .then((data) => {
        if (!cancelled) setEvent(data);
      })
      .catch((err) => console.error("Failed to load event", err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Seed the trip's date window + "already added" state from the current
  // trip's itinerary, so an event added on a previous visit shows "Remove"
  // rather than a dead-end "Added", and so outsideTripDates below is correct
  // on first paint.
  useEffect(() => {
    if (!deviceId || !event) return;
    let cancelled = false;
    (async () => {
      try {
        const trip = await getCurrentTrip(deviceId);
        if (!trip || cancelled) return;
        setTripStartDate(trip.start_date);
        setTripEndDate(trip.end_date);
        const items = await listItems(deviceId, trip.id);
        if (cancelled) return;
        const dayDate = eventDayDate(event.starts_at);
        const match = items.find(
          (it) =>
            it.title?.trim().toLowerCase() === event.name.trim().toLowerCase() &&
            it.day_date === dayDate
        );
        if (match) {
          setAddState("added");
          setItemId(match.id);
        }
      } catch (err) {
        console.error("Failed to check itinerary status", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, event]);

  const dayDate = event ? eventDayDate(event.starts_at) : "";
  const outsideTripDates =
    !!tripStartDate &&
    !!tripEndDate &&
    !!dayDate &&
    (dayDate < tripStartDate || dayDate > tripEndDate);

  async function handleAddToTrip() {
    if (!deviceId || !event || addState === "adding" || addState === "added" || outsideTripDates) return;
    setAddState("adding");
    try {
      const trip = await getCurrentTrip(deviceId);
      if (!trip) {
        setAddState("idle");
        router.push("/plan/new-trip");
        return;
      }
      const created = await createItem(deviceId, {
        trip_id: trip.id,
        place_id: event.place_id,
        title: event.name,
        category: "activity",
        location: event.venue_name ?? event.address,
        day_date: eventDayDate(event.starts_at),
        time_label: formatEventTime(event.starts_at),
      });
      setItemId(created.id);
      setAddState("added");
    } catch (err) {
      console.error("Failed to add event to trip", err);
      setAddState("error");
    }
  }

  /** Un-add: same `deleteItem` used everywhere else "Add to itinerary"
   * exists — no duplicate removal logic added. */
  async function handleRemoveFromTrip() {
    if (!deviceId || !itemId || addState === "removing") return;
    setAddState("removing");
    try {
      await deleteItem(deviceId, itemId);
      setItemId(null);
      setAddState("idle");
    } catch (err) {
      console.error("Failed to remove event from trip", err);
      setAddState("error");
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Icon name="auto_awesome" size={32} className="animate-pulse text-primary" />
      </div>
    );
  }

  if (!event) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Event" showBack />
        <div className="flex flex-col items-center gap-3 px-5 py-16 text-center text-on-surface-variant">
          <Icon name="event_busy" size={32} />
          <p className="text-body-md">We couldn&rsquo;t find this event.</p>
          <Link href="/events" className="text-label-md font-medium text-secondary">
            Back to What&rsquo;s On
          </Link>
        </div>
      </div>
    );
  }

  const directionsUrl = eventDirectionsUrl(event);
  const price = formatEventPrice(event);
  // Event has a single image_url, no place_photos-style gallery — one-item
  // array reuses PhotoCarousel's existing placeholder-when-empty behavior
  // (see app/(shell)/place/[id]/page.tsx) rather than a bespoke hero block.
  const heroPhotos: CarouselPhoto[] = event.image_url ? [{ url: event.image_url, alt: event.name }] : [];

  function openDirections() {
    if (directionsUrl) window.open(directionsUrl, "_blank", "noopener");
  }

  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageHeader title={event.name} showBack />

      {/* Hero */}
      <section className="relative h-64 w-full overflow-hidden">
        <PhotoCarousel key={event.id} photos={heroPhotos} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-background/90 to-transparent" />
        <div className="absolute bottom-4 left-5 z-20">
          <StatusPill label={formatEventWhen(event.starts_at, event.ends_at)} tone="info" icon="schedule" />
        </div>
      </section>

      <div className="flex flex-col gap-6 px-5">
        {/* Description & stats */}
        <section className="rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-5 shadow-sm">
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
          <p className="mb-4 text-body-md text-on-surface-variant">
            {event.description ??
              `${event.category ?? "Event"} at ${event.venue_name ?? event.city ?? "this venue"}.`}
          </p>
          <div className="grid grid-cols-2 gap-4 border-t border-outline-variant/30 pt-4">
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
                  {event.venue_name ?? event.address ?? "—"}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Mini map */}
        <section>
          <h2 className="mb-4 text-headline-sm text-primary">Location</h2>
          <button
            type="button"
            onClick={openDirections}
            disabled={!directionsUrl}
            className="relative h-40 w-full overflow-hidden rounded-xl border border-outline-variant/40 bg-surface-container text-left disabled:pointer-events-none disabled:opacity-60"
          >
            <div className="absolute inset-0 flex items-center justify-center">
              <Icon name="map" size={64} className="text-outline-variant" />
            </div>
            <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between rounded-lg bg-white/90 px-3 py-2 backdrop-blur-md">
              <div>
                <p className="text-label-md text-primary">
                  {event.venue_name ?? event.address ?? event.name}
                </p>
                <p className="text-label-sm text-on-surface-variant">
                  {directionsUrl ? "Tap to open directions" : "Location unavailable"}
                </p>
              </div>
              <Icon name="open_in_new" className="text-primary" />
            </div>
          </button>
        </section>
      </div>

      {/* Sticky bottom actions */}
      <div className="sticky bottom-[64px] z-30 flex flex-col gap-2 border-t border-outline-variant/40 bg-surface-container-lowest/95 px-5 py-4 backdrop-blur-md shadow-[0_-4px_16px_rgba(3,22,50,0.08)]">
        {addState === "added" ? (
          <div className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-on-primary">
            <Icon name="check_circle" filled size={18} className="text-secondary-container" />
            <p className="flex-1 text-label-md">Added to your trip.</p>
            <Link href="/plan" className="text-label-md font-semibold text-secondary-container">
              View Plan
            </Link>
          </div>
        ) : null}
        {addState === "error" ? (
          <div className="rounded-xl bg-error-container px-4 py-2.5 text-label-md text-on-error-container">
            Couldn&rsquo;t update your trip. Try again.
          </div>
        ) : null}
        {outsideTripDates && addState !== "added" ? (
          <p className="text-label-sm text-on-surface-variant">
            This event falls outside your trip dates, so it can&rsquo;t be added to the itinerary.
          </p>
        ) : null}
        <div className="flex gap-3">
          {event.ticket_url ? (
            <a
              href={event.ticket_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl bg-secondary-container px-4 text-label-md font-semibold text-on-secondary-container shadow-sm transition-opacity hover:opacity-90"
            >
              <Icon name="confirmation_number" size={18} />
              Get tickets
            </a>
          ) : (
            <Button
              variant="orange"
              fullWidth
              leadingIcon="directions"
              onClick={openDirections}
              disabled={!directionsUrl}
            >
              Get Directions
            </Button>
          )}
          <Link
            href={buildAskRoameoHref({
              type: "event",
              id,
              name: event.name,
              coords: event.lat != null && event.lng != null ? { lat: event.lat, lng: event.lng } : null,
              returnTo: pathname,
            })}
            aria-label="Ask Roameo about this event"
            className="flex min-h-[48px] items-center justify-center rounded-xl border-[1.5px] border-primary px-4 text-primary transition-colors hover:bg-primary/5 active:bg-primary/10"
          >
            <Icon name="chat" size={20} />
          </Link>
          <Button
            variant={addState === "added" ? "danger" : "outline"}
            leadingIcon={addState === "added" ? "delete" : "add_circle"}
            onClick={addState === "added" ? handleRemoveFromTrip : handleAddToTrip}
            disabled={
              addState === "adding" || addState === "removing" || (addState !== "added" && outsideTripDates)
            }
          >
            {outsideTripDates && addState !== "added"
              ? "Outside trip dates"
              : addState === "added"
                ? "Remove"
                : addState === "adding"
                  ? "Adding…"
                  : addState === "removing"
                    ? "Removing…"
                    : "Add"}
          </Button>
        </div>
      </div>
    </div>
  );
}
