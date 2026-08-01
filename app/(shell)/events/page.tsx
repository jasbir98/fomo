"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useDeviceId } from "@/lib/device";
import { getCurrentTrip } from "@/lib/db";
import type { EventItem, Trip } from "@/lib/types";
import { distanceKm, sortByDistance, useGeolocation, type Coordinates } from "@/lib/geo";
import { useProgressiveReveal } from "@/lib/useProgressiveReveal";
import { Chip, Icon, PageHeader, SegmentedControl } from "@/components/ui";
import { EventCard, EventDetailSheet } from "@/components/events";

/** Shape of GET /api/events' response (route.ts's EventsResponse isn't exported). */
interface EventsApiResponse {
  center: { lat: number; lng: number } | null;
  events: EventItem[];
  degraded?: string;
}

type DateWindow = "tonight" | "weekend" | "week";

/** Category chip → the slug /api/events' `category` param understands
 * (lib/events/categories.ts's EventCategory — that file is server-only, so
 * this list is duplicated here rather than imported). */
const CATEGORY_FILTERS: { label: string; icon: string; slug: string }[] = [
  { label: "Music", icon: "music_note", slug: "music" },
  { label: "Nightlife", icon: "nightlife", slug: "nightlife" },
  { label: "Festivals", icon: "celebration", slug: "festival" },
  { label: "Arts", icon: "theater_comedy", slug: "arts" },
  { label: "Comedy", icon: "mood", slug: "comedy" },
  { label: "Sports", icon: "sports_soccer", slug: "sports" },
  { label: "Food", icon: "restaurant", slug: "food" },
  { label: "Family", icon: "family_restroom", slug: "family" },
];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/** Computes the `from`/`to` ISO window for a DateWindow, anchored to "now". */
function windowRange(window: DateWindow, now: Date): { from: string; to: string } {
  if (window === "tonight") {
    return { from: now.toISOString(), to: endOfDay(now).toISOString() };
  }
  if (window === "weekend") {
    const day = now.getDay(); // 0 = Sun, 6 = Sat
    const daysUntilSat = day === 6 ? 0 : day === 0 ? -1 : 6 - day;
    const saturday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilSat);
    const sunday = new Date(saturday.getFullYear(), saturday.getMonth(), saturday.getDate() + 1);
    const from = daysUntilSat < 0 ? now : startOfDay(saturday);
    return { from: from.toISOString(), to: endOfDay(sunday).toISOString() };
  }
  // "week" — next 7 days from now.
  const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { from: now.toISOString(), to: weekOut.toISOString() };
}

/** Event coordinate extractor for sortByDistance. */
function eventCoords(event: EventItem): Coordinates | null {
  return event.lat != null && event.lng != null ? { lat: event.lat, lng: event.lng } : null;
}

export default function EventsPage() {
  const deviceId = useDeviceId();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [tripChecked, setTripChecked] = useState(false);
  const [dateWindow, setDateWindow] = useState<DateWindow>("tonight");
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<EventItem | null>(null);
  const { coords } = useGeolocation();

  const destination = trip?.destination ?? null;

  // Load the active trip once — no auto-seed, mirrors app/(shell)/map/page.tsx.
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const t = await getCurrentTrip(deviceId);
        if (!cancelled) setTrip(t);
      } catch (err) {
        console.error("[events] trip load failed", err);
      } finally {
        if (!cancelled) setTripChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  // Fetch events whenever the destination, date window, or category changes.
  useEffect(() => {
    if (!destination) return; // guards the initial mount — loading stays true
    let cancelled = false;
    const { from, to } = windowRange(dateWindow, new Date());
    const params = new URLSearchParams({ destination, from, to, limit: "100" });
    if (activeSlug) params.set("category", activeSlug);

    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/events?${params.toString()}`);
        const data = (await res.json()) as EventsApiResponse;
        if (cancelled) return;
        setEvents(data.events ?? []);
        setDegraded(data.degraded ?? null);
      } catch (err) {
        if (!cancelled) console.error("[events] events load failed", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();

    // Events can also land via the Home carousel's fetch elsewhere in the
    // app — refetch on tab focus so a stale list doesn't linger.
    function onVisibilityChange() {
      if (document.visibilityState === "visible") void load();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onVisibilityChange);
    };
  }, [destination, dateWindow, activeSlug]);

  // Nearest-to-farthest from the device's live location; unchanged order
  // when location is unavailable/denied (silent fallback, per lib/geo.ts).
  const sortedEvents = useMemo(() => sortByDistance(events, coords, eventCoords), [events, coords]);

  // This is a vertical page list with no inner scrolling container -- the
  // viewport itself is what scrolls, so root must be `null` (viewport), not
  // a ref to the non-scrolling wrapper div below (that root never scrolls,
  // so the sentinel's intersection never fires and the list dead-ends at
  // the first `step` batch).
  const listSentinelRef = useRef<HTMLDivElement>(null);
  const visibleCount = useProgressiveReveal(sortedEvents.length, null, listSentinelRef, { vertical: true });

  // No active trip — invite the traveler to create one (events need a destination).
  if (tripChecked && !trip) {
    return (
      <div className="flex min-h-dvh flex-col">
        <PageHeader title="What's On" showBack />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary-fixed text-primary">
            <Icon name="event" size={40} filled />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-headline-md text-primary">No trip to explore yet</h2>
            <p className="text-body-lg text-on-surface-variant">
              Create a trip and Roameo will surface events happening nearby.
            </p>
          </div>
          <Link
            href="/plan/new-trip"
            className="mt-2 inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-secondary-container px-6 text-label-md font-semibold text-on-secondary-container shadow-sm transition-opacity hover:opacity-90"
          >
            <Icon name="add" size={20} />
            Create a trip
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 pb-6">
      <PageHeader title="What's On" showBack />

      <div className="flex flex-col gap-4 px-5">
        <SegmentedControl<DateWindow>
          value={dateWindow}
          onChange={setDateWindow}
          options={[
            { value: "tonight", label: "Tonight" },
            { value: "weekend", label: "This weekend" },
            { value: "week", label: "Next 7 days" },
          ]}
          className="w-full"
        />

        <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [&::-webkit-scrollbar]:hidden">
          {CATEGORY_FILTERS.map((c) => (
            <Chip
              key={c.slug}
              label={c.label}
              leadingIcon={c.icon}
              selected={activeSlug === c.slug}
              onClick={() => setActiveSlug((prev) => (prev === c.slug ? null : c.slug))}
            />
          ))}
        </div>

        {degraded ? (
          <p className="text-label-sm text-on-surface-variant">
            {degraded === "no-event-keys"
              ? "Live events aren't configured yet — add SKIDDLE_API_KEY / TICKETMASTER_API_KEY to see What's On."
              : degraded === "cache-unavailable"
                ? "Live events shown; run the events migration to enable full detail."
                : "Couldn't reach live events — showing what we have."}
          </p>
        ) : null}
      </div>

      <section className="flex flex-col gap-3 px-5 pt-1">
        {loading ? (
          <div className="flex justify-center py-6">
            <Icon name="auto_awesome" size={28} className="animate-pulse text-primary" />
          </div>
        ) : sortedEvents.length === 0 ? (
          <p className="text-body-md text-on-surface-variant">
            No events found for this window yet.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {sortedEvents.slice(0, visibleCount).map((event) => {
              const c = eventCoords(event);
              const dist = coords && c ? distanceKm(coords, c) : null;
              return (
                <EventCard
                  key={event.id}
                  event={event}
                  variant="list"
                  distanceKm={dist}
                  onClick={() => setSelectedEvent(event)}
                />
              );
            })}
            <div ref={listSentinelRef} className="h-px w-full shrink-0" />
          </div>
        )}
      </section>

      <EventDetailSheet
        open={selectedEvent !== null}
        onClose={() => setSelectedEvent(null)}
        event={selectedEvent}
        deviceId={deviceId}
      />
    </div>
  );
}
