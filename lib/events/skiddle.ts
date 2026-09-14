// Server-side Skiddle Events API search for the /api/events route. UK-only
// (Skiddle has no international coverage) — see lib/events/index.ts for the
// UK-detection gate that decides whether this provider is even called.
import "server-only";
import type { Center } from "@/lib/places/geocode";
import { categoryFromSkiddleCode, type EventCategory } from "./categories";

/** Thrown when Skiddle returns a non-2xx or the request otherwise fails. */
export class SkiddleError extends Error {}

// A live-fetched event mapped to the `events` upsert shape. Not a full
// EventItem row — the DB fills id / created_at; the route builds an EventItem
// from this either via the upsert-returned row or (in fallback) synthetically.
export interface MappedEvent {
  provider: string;
  provider_event_id: string;
  name: string;
  description: string | null;
  category: EventCategory | null;
  image_url: string | null;
  ticket_url: string | null;
  starts_at: string;
  ends_at: string | null;
  venue_name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  city: string | null;
  // Explicitly set (even when null) so this always overrides the `events`
  // table's lack of a `country` default correctly — see the comment at the
  // top of supabase/add_events.sql for why this column has NO default.
  country: string | null;
  is_free: boolean | null;
  price_from: number | null;
  currency: string | null;
  destination: string;
  fetched_at: string;
}

// Raw shape of a single event from Skiddle's /events/search/ response (fields
// we read). Skiddle's docs describe this loosely; keep the parse defensive.
interface SkiddleEvent {
  id?: string | number;
  eventname?: string;
  description?: string;
  eventcode?: string;
  largeimageurl?: string;
  imageurl?: string;
  link?: string;
  admin?: { link?: string };
  startdate?: string; // "2026-08-08 20:00:00"
  enddate?: string;
  venue?: {
    name?: string;
    address?: string;
    town?: string;
    latitude?: string | number;
    longitude?: string | number;
  };
  latitude?: string | number;
  longitude?: string | number;
  entryprice?: string; // e.g. "Free", "£12.50"
  currency?: string;
}

// Skiddle serves a generic "no photo available" graphic (not a real event
// photo) from its CDN whenever an event/venue has no uploaded image — e.g.
// https://d1plawd8huk6hh.cloudfront.net/assets/default400.png. That URL is
// non-null like any real photo, so left unfiltered it reads as a usable
// image everywhere downstream (event cards, and — worse — the Home hero,
// which shows this literal placeholder graphic instead of falling back to
// the app's own gradient+glyph placeholder). Treat it as no image.
const SKIDDLE_PLACEHOLDER_IMAGE = /\/assets\/default\d*\.png$/i;

function realSkiddleImage(url: string | null | undefined): string | null {
  if (!url || SKIDDLE_PLACEHOLDER_IMAGE.test(url)) return null;
  return url;
}

/**
 * Exported so lib/now/generators.ts can apply the same filter at read time —
 * `events` rows cached before this filter existed still carry the raw
 * placeholder URL in the DB (6h TTL), so relying on write-time filtering
 * alone would keep serving it as a "real" photo until the cache expires.
 */
export function realEventImage(url: string | null | undefined): string | null {
  return realSkiddleImage(url);
}

/** Skiddle dates arrive as "YYYY-MM-DD HH:mm:ss" (no timezone) — treat as UK local. */
function parseSkiddleDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const iso = raw.trim().replace(" ", "T");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parsePrice(raw: string | undefined): { isFree: boolean | null; priceFrom: number | null } {
  if (!raw) return { isFree: null, priceFrom: null };
  const trimmed = raw.trim();
  if (/free/i.test(trimmed)) return { isFree: true, priceFrom: 0 };
  const match = trimmed.match(/[\d.]+/);
  if (!match) return { isFree: null, priceFrom: null };
  const value = Number(match[0]);
  return { isFree: false, priceFrom: Number.isFinite(value) ? value : null };
}

function mapEvent(event: SkiddleEvent, destination: string): MappedEvent | null {
  const id = event.id != null ? String(event.id) : null;
  const starts_at = parseSkiddleDate(event.startdate);
  if (!id || !event.eventname || !starts_at) return null; // need a stable key + name + date

  const lat = event.venue?.latitude ?? event.latitude;
  const lng = event.venue?.longitude ?? event.longitude;
  const { isFree, priceFrom } = parsePrice(event.entryprice);

  return {
    provider: "skiddle",
    provider_event_id: id,
    name: event.eventname,
    description: event.description ?? null,
    category: categoryFromSkiddleCode(event.eventcode),
    image_url: realSkiddleImage(event.largeimageurl) ?? realSkiddleImage(event.imageurl),
    ticket_url: event.link ?? event.admin?.link ?? null,
    starts_at,
    ends_at: parseSkiddleDate(event.enddate),
    venue_name: event.venue?.name ?? null,
    address: [event.venue?.address, event.venue?.town].filter(Boolean).join(", ") || null,
    lat: lat != null ? Number(lat) : null,
    lng: lng != null ? Number(lng) : null,
    city: event.venue?.town ?? null,
    country: "GB", // Skiddle is UK-only — always set explicitly, never left to a default.
    is_free: isFree,
    price_from: priceFrom,
    currency: isFree ? null : event.currency ?? "GBP",
    destination,
    fetched_at: new Date().toISOString(),
  };
}

export interface SearchSkiddleOpts {
  destination: string;
  center: Center;
  radiusKm: number;
  category?: EventCategory;
  q?: string;
  from?: string; // ISO date/time
  to?: string;
  limit: number;
}

// Reverse of categoryFromSkiddleCode — used to translate a Fomo category
// filter back into Skiddle's `eventcode` query param.
const CATEGORY_TO_EVENTCODE: Partial<Record<EventCategory, string>> = {
  nightlife: "CLUB",
  music: "LIVE",
  festival: "FEST",
  arts: "ARTS",
  comedy: "COMEDY",
  food: "DATE",
  family: "KIDS",
  sports: "SPORT",
};

/**
 * Search Skiddle for events near `center` and return them mapped to the
 * `events` upsert shape. Throws SkiddleError on network / non-2xx / bad key
 * so the registry (lib/events/index.ts) can record it in `providersFailed`.
 * The caller guarantees the API key exists and the destination is UK-based.
 */
export async function searchSkiddleEvents(opts: SearchSkiddleOpts): Promise<MappedEvent[]> {
  const apiKey = process.env.SKIDDLE_API_KEY;
  if (!apiKey) throw new SkiddleError("missing SKIDDLE_API_KEY");

  const { destination, center, radiusKm, category, q, from, to, limit } = opts;

  const params = new URLSearchParams({
    api_key: apiKey,
    latitude: String(center.lat),
    longitude: String(center.lng),
    radius: String(Math.max(1, Math.round(radiusKm * 0.621371))), // km -> miles, Skiddle's unit
    order: "distance",
    getdistance: "1",
    description: "1",
    limit: String(Math.min(Math.max(limit, 1), 100)),
    country: "GB",
  });
  const eventcode = category ? CATEGORY_TO_EVENTCODE[category] : undefined;
  if (eventcode) params.set("eventcode", eventcode);
  if (q) params.set("keyword", q);
  if (from) params.set("minDate", from.slice(0, 10));
  if (to) params.set("maxDate", to.slice(0, 10));

  let res: Response;
  try {
    res = await fetch(`https://www.skiddle.com/api/v1/events/search/?${params.toString()}`);
  } catch (err) {
    throw new SkiddleError(
      `network error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new SkiddleError(`${res.status} ${res.statusText} ${detail}`.trim());
  }

  const data = (await res.json()) as { results?: SkiddleEvent[]; error?: string };
  if (data.error) throw new SkiddleError(`api error: ${data.error}`);

  const results = data.results ?? [];
  return results
    .map((e) => mapEvent(e, destination))
    .filter((e): e is MappedEvent => e !== null);
}
