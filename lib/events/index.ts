// Event provider registry — fan out to every enabled provider and merge the
// results. New providers (e.g. a future Japan source, or Eventbrite) register
// here only; the route and UI never need to change.
import "server-only";
import type { Center } from "@/lib/places/geocode";
import type { EventCategory } from "./categories";
import { searchSkiddleEvents, SkiddleError, type MappedEvent } from "./skiddle";
import { searchTicketmasterEvents, TicketmasterError } from "./ticketmaster";

export type { MappedEvent };

export interface SearchEventsParams {
  destination: string;
  center: Center;
  radiusKm?: number;
  category?: EventCategory;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface SearchEventsResult {
  events: MappedEvent[];
  providersUsed: string[];
  providersFailed: string[];
}

// Skiddle is UK-only and has no country field on its own search response, so
// UK-ness is decided from the geocoded center via a bounding box rather than
// a second geocoding round-trip (cheaper, and "good enough" — the box is a
// generous superset of the UK/Ireland landmass; a false positive just means
// Skiddle is called and returns zero results, which is harmless).
const UK_BBOX = { latMin: 49.8, latMax: 61.0, lngMin: -8.7, lngMax: 2.0 };

function isLikelyUK(center: Center): boolean {
  return (
    center.lat >= UK_BBOX.latMin &&
    center.lat <= UK_BBOX.latMax &&
    center.lng >= UK_BBOX.lngMin &&
    center.lng <= UK_BBOX.lngMax
  );
}

const DEFAULT_RADIUS_KM = 25;
const DEFAULT_LIMIT = 20;

/**
 * Fan out to every enabled event provider (one that has an API key set) and
 * merge the results. `Promise.allSettled` so one provider failing never kills
 * the response. A provider with no key configured is skipped silently (not
 * counted as failed) — only a configured provider that actually errors lands
 * in `providersFailed`.
 */
export async function searchEvents(
  params: SearchEventsParams
): Promise<SearchEventsResult> {
  const {
    destination,
    center,
    radiusKm = DEFAULT_RADIUS_KM,
    category,
    q,
    from,
    to,
    limit = DEFAULT_LIMIT,
  } = params;

  const jobs: { name: string; run: () => Promise<MappedEvent[]> }[] = [];

  if (process.env.TICKETMASTER_API_KEY) {
    jobs.push({
      name: "ticketmaster",
      run: () =>
        searchTicketmasterEvents({ destination, center, radiusKm, category, q, from, to, limit }),
    });
  }

  if (process.env.SKIDDLE_API_KEY && isLikelyUK(center)) {
    jobs.push({
      name: "skiddle",
      run: () =>
        searchSkiddleEvents({ destination, center, radiusKm, category, q, from, to, limit }),
    });
  }

  if (jobs.length === 0) {
    return { events: [], providersUsed: [], providersFailed: [] };
  }

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));

  const events: MappedEvent[] = [];
  const providersUsed: string[] = [];
  const providersFailed: string[] = [];

  settled.forEach((result, i) => {
    const name = jobs[i].name;
    if (result.status === "fulfilled") {
      providersUsed.push(name);
      events.push(...result.value);
    } else {
      providersFailed.push(name);
      const reason = result.reason;
      const isTypedError = reason instanceof SkiddleError || reason instanceof TicketmasterError;
      console.error(
        `[api/events] provider "${name}" failed${isTypedError ? "" : " (unexpected error type)"}`,
        reason
      );
    }
  });

  return { events, providersUsed, providersFailed };
}
