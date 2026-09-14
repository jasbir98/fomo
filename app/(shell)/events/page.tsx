"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CITY } from "@/lib/city";
import type { EventItem } from "@/lib/types";
import { distanceKm, sortByDistance, useGeolocation, type Coordinates } from "@/lib/geo";
import { useInfiniteList } from "@/lib/useInfiniteList";
import { Chip, Icon, PageHeader, SegmentedControl } from "@/components/ui";
import { EventCard } from "@/components/events";

// Page size for the infinite-scroll fetch below. /api/events itself has no
// true offset pagination (it's a cache-first-then-provider-fan-out lookup
// keyed on `limit` alone, not skip/take) — the fetchPage adapter below works
// within that by asking for `offset + limit` rows each page and slicing out
// the new tail, capped at the route's own max (100, see app/api/events/route.ts).
const PAGE_SIZE = 24;
const EVENTS_API_MAX = 100;

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
  const router = useRouter();
  const [dateWindow, setDateWindow] = useState<DateWindow>("tonight");
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [degraded, setDegraded] = useState<string | null>(null);
  const { coords } = useGeolocation();

  const destination = CITY.name;

  // Events can also land via the Home carousel's fetch elsewhere in the app —
  // bumping this on tab focus (same as before this refactor) forces the
  // infinite-list hook's page-1 effect to re-run by including it in `deps`
  // below, so a stale list doesn't linger after switching back to this tab.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === "visible") setRefreshTick((t) => t + 1);
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onVisibilityChange);
    };
  }, []);

  // Paginated fetch — shared infinite-scroll machinery lives in
  // lib/useInfiniteList.ts (same hook as app/(shell)/experiences/page.tsx).
  // Not attaching `rootRef` to anything below keeps the IntersectionObserver
  // `root` at `null` (the viewport) — the Phase A fix this page needed: it's
  // a vertical page list with no inner scrolling container, so a root
  // pointed at a non-scrolling wrapper div would never fire the sentinel's
  // intersection at all.
  const {
    items: events,
    loading,
    loadingMore,
    hasMore,
    sentinelRef: listSentinelRef,
  } = useInfiniteList<EventItem>(
    {
      enabled: !!destination,
      pageSize: PAGE_SIZE,
      getId: (e) => e.id,
      onError: (err, phase) =>
        console.error(`[events] events ${phase === "initial" ? "load" : "load more"} failed`, err),
      fetchPage: async ({ limit, offset }) => {
        if (!destination) return [];
        const { from, to } = windowRange(dateWindow, new Date());
        const params = new URLSearchParams({
          destination,
          from,
          to,
          limit: String(Math.min(offset + limit, EVENTS_API_MAX)),
        });
        if (activeSlug) params.set("category", activeSlug);
        const res = await fetch(`/api/events?${params.toString()}`);
        const data = (await res.json()) as EventsApiResponse;
        setDegraded(data.degraded ?? null);
        const fetched = data.events ?? [];
        return offset < fetched.length ? fetched.slice(offset, offset + limit) : [];
      },
    },
    [destination, dateWindow, activeSlug, refreshTick]
  );

  // Nearest-to-farthest from the device's live location; unchanged order
  // when location is unavailable/denied (silent fallback, per lib/geo.ts).
  const sortedEvents = useMemo(() => sortByDistance(events, coords, eventCoords), [events, coords]);

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
            {sortedEvents.map((event) => {
              const c = eventCoords(event);
              const dist = coords && c ? distanceKm(coords, c) : null;
              return (
                <EventCard
                  key={event.id}
                  event={event}
                  variant="list"
                  distanceKm={dist}
                  onClick={() => router.push(`/event/${event.id}`)}
                />
              );
            })}
            {hasMore ? (
              <div ref={listSentinelRef} className="flex justify-center py-4">
                {loadingMore ? (
                  <Icon name="hourglass_top" size={22} className="animate-pulse text-primary" />
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
