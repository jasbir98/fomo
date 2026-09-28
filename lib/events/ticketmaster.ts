// Server-side Ticketmaster Discovery v2 search for the /api/events route.
// Global coverage (unlike Skiddle), but thin in some regions (e.g. Japan) —
// see lib/events/index.ts and the plan for the documented coverage gap.
import "server-only";
import type { Center } from "@/lib/places/geocode";
import { encodeGeohash } from "./geohash";
import { categoryFromTicketmasterSegment, type EventCategory } from "./categories";
import type { MappedEvent } from "./skiddle";

/** Thrown when Ticketmaster returns a non-2xx (esp. 401/403 = bad key) or the request otherwise fails. */
export class TicketmasterError extends Error {}

interface TmImage {
  url?: string;
  width?: number;
  height?: number;
  ratio?: string;
}

interface TmVenue {
  name?: string;
  address?: { line1?: string };
  city?: { name?: string };
  country?: { countryCode?: string };
  location?: { latitude?: string; longitude?: string };
}

interface TmClassification {
  segment?: { name?: string };
}

interface TmEvent {
  id?: string;
  name?: string;
  info?: string;
  pleaseNote?: string;
  url?: string;
  images?: TmImage[];
  dates?: { start?: { dateTime?: string; localDate?: string } };
  classifications?: TmClassification[];
  priceRanges?: { min?: number; currency?: string }[];
  _embedded?: { venues?: TmVenue[] };
}

/** Pick the widest available image, preferring a 16:9 ratio (best for card art). */
function pickImage(images: TmImage[] | undefined): string | null {
  if (!images || images.length === 0) return null;
  const sixteenByNine = images.filter((i) => i.ratio === "16_9");
  const pool = sixteenByNine.length > 0 ? sixteenByNine : images;
  const widest = [...pool].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return widest?.url ?? null;
}

function mapEvent(event: TmEvent, destination: string): MappedEvent | null {
  const id = event.id;
  const starts_at = event.dates?.start?.dateTime;
  if (!id || !event.name || !starts_at) return null; // need a stable key + name + date

  const venue = event._embedded?.venues?.[0];
  // Ticketmaster returns lat/lng as strings — parse them.
  const lat = venue?.location?.latitude != null ? Number(venue.location.latitude) : null;
  const lng = venue?.location?.longitude != null ? Number(venue.location.longitude) : null;
  const segmentName = event.classifications?.[0]?.segment?.name;
  const price = event.priceRanges?.[0];

  return {
    provider: "ticketmaster",
    provider_event_id: id,
    name: event.name,
    description: event.info ?? event.pleaseNote ?? null,
    category: categoryFromTicketmasterSegment(segmentName),
    image_url: pickImage(event.images),
    ticket_url: event.url ?? null,
    starts_at,
    ends_at: null, // Discovery v2 rarely supplies a reliable end time
    venue_name: venue?.name ?? null,
    address: [venue?.address?.line1, venue?.city?.name].filter(Boolean).join(", ") || null,
    lat: lat != null && Number.isFinite(lat) ? lat : null,
    lng: lng != null && Number.isFinite(lng) ? lng : null,
    city: venue?.city?.name ?? null,
    // Explicitly set (even when null) — never rely on the `events` table's
    // lack of a `country` default; see supabase/archive/add_events.sql.
    country: venue?.country?.countryCode ?? null,
    is_free: null, // Discovery v2 doesn't reliably flag free events
    price_from: typeof price?.min === "number" ? price.min : null,
    currency: price?.currency ?? null,
    destination,
    fetched_at: new Date().toISOString(),
  };
}

export interface SearchTicketmasterOpts {
  destination: string;
  center: Center;
  radiusKm: number;
  category?: EventCategory;
  q?: string;
  from?: string; // ISO date/time
  to?: string;
  limit: number;
}

// Reverse of categoryFromTicketmasterSegment — used to translate a Fomo
// category filter back into Ticketmaster's `classificationName` param.
const CATEGORY_TO_SEGMENT: Partial<Record<EventCategory, string>> = {
  music: "Music",
  sports: "Sports",
  arts: "Arts & Theatre",
};

function toTmDateTime(iso: string): string {
  // Discovery v2 wants "YYYY-MM-DDTHH:mm:ssZ" (no milliseconds).
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Search Ticketmaster Discovery v2 for events near `center` and return them
 * mapped to the `events` upsert shape. Throws TicketmasterError on network /
 * non-2xx (401/403 = bad key) so the registry can record it in
 * `providersFailed`. The caller guarantees the API key exists. Rate limit is
 * 5 req/s — this issues a single sequential call, never parallelised within
 * the provider.
 */
export async function searchTicketmasterEvents(
  opts: SearchTicketmasterOpts
): Promise<MappedEvent[]> {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) throw new TicketmasterError("missing TICKETMASTER_API_KEY");

  const { destination, center, radiusKm, category, q, from, to, limit } = opts;

  const params = new URLSearchParams({
    apikey: apiKey,
    geoPoint: encodeGeohash(center.lat, center.lng, 9),
    radius: String(Math.max(1, Math.round(radiusKm))),
    unit: "km",
    size: String(Math.min(Math.max(limit, 1), 100)),
    sort: "date,asc",
  });
  const segment = category ? CATEGORY_TO_SEGMENT[category] : undefined;
  if (segment) params.set("classificationName", segment);
  if (q) params.set("keyword", q);
  if (from) params.set("startDateTime", toTmDateTime(from));
  if (to) params.set("endDateTime", toTmDateTime(to));

  let res: Response;
  try {
    res = await fetch(
      `https://app.ticketmaster.com/discovery/v2/events.json?${params.toString()}`
    );
  } catch (err) {
    throw new TicketmasterError(
      `network error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new TicketmasterError(`${res.status} ${res.statusText} ${detail}`.trim());
  }

  const data = (await res.json()) as { _embedded?: { events?: TmEvent[] } };
  const events = data._embedded?.events ?? [];
  return events
    .map((e) => mapEvent(e, destination))
    .filter((e): e is MappedEvent => e !== null);
}
