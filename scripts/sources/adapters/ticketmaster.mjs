/**
 * ticketmaster adapter — proactive, paginated pull of the Ticketmaster
 * Discovery v2 API (/events.json, needs TICKETMASTER_API_KEY; skipped with a
 * log line when absent).
 *
 * lib/events/ticketmaster.ts has the same field mapping for the app's live
 * path: provider_event_id is event.id, untransformed, so a re-discovered event
 * upserts onto the same (provider, provider_event_id) row.
 */

import { cleanDescription } from "../../lib/describe.mjs";
import { httpUrlOrNull } from "../../lib/http-url.mjs";
import { DESTINATION, LOOKAHEAD_DAYS, PROACTIVE_RADIUS_MILES } from "../core/config.mjs";
import { CATEGORY_STATS, EDINBURGH_CENTER, classifyCategory, dedupeWithinSource, isOffWedge } from "../core/normalize.mjs";
import { emptyStats } from "../core/stats.mjs";

export const TICKETMASTER_SEGMENT_MAP = {
  Music: "music",
  Sports: "sports",
  "Arts & Theatre": "arts",
  Film: "arts",
  Miscellaneous: "other",
};
export function categoryFromTicketmasterSegment(raw) {
  if (!raw) return "other";
  return TICKETMASTER_SEGMENT_MAP[String(raw).trim()] ?? "other";
}

// Minimal lat/lng -> geohash encoder for Ticketmaster Discovery v2's
// `geoPoint` param — same standard base32 geohash algorithm as
// lib/events/geohash.ts's encodeGeohash(), reimplemented here since this
// script is plain Node with no `@/` import alias.
const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
export function encodeGeohash(lat, lng, precision = 9) {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let hash = "";
  let bit = 0;
  let ch = 0;
  let evenBit = true;
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { ch = (ch << 1) | 1; lngMin = mid; } else { ch = ch << 1; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latMin = mid; } else { ch = ch << 1; latMax = mid; }
    }
    evenBit = !evenBit;
    if (++bit === 5) { hash += GEOHASH_BASE32[ch]; bit = 0; ch = 0; }
  }
  return hash;
}

/** Pick the widest available image, preferring 16:9 — same as lib/events/ticketmaster.ts's pickImage(). */
export function pickTmImage(images) {
  if (!images || images.length === 0) return null;
  const sixteenByNine = images.filter((i) => i.ratio === "16_9");
  const pool = sixteenByNine.length > 0 ? sixteenByNine : images;
  const widest = [...pool].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return widest?.url ?? null;
}

/**
 * Ticketmaster events almost never carry a real `description` (empty string
 * on essentially every live row checked) — the closest things to "what is
 * this event" are `info` (doors/start/curfew times, then ticket-limit legal
 * text) and `pleaseNote` (almost entirely age-restriction/ticket-limit
 * legal text), and `promoter.description` is actually just the promoter's
 * company-registration string ("KMJ ENTERTAINMENT LTD / NTL / GBR"), not a
 * description of the event. Try each field in this priority order through
 * cleanDescription (which strips exactly that kind of boilerplate) and use
 * the first that survives cleaning.
 */
export function bestTicketmasterDescription(event, { title }) {
  const candidates = [event.info, event.pleaseNote, event.description, event.promoter?.description];
  for (const candidate of candidates) {
    const cleaned = cleanDescription(candidate, { title });
    if (cleaned) return cleaned;
  }
  return null;
}

/** Ticketmaster `dates.status.code` -> events.status: cancelled/postponed events stay in the table as "cancelled". */
export function ticketmasterStatus(event) {
  const code = String(event.dates?.status?.code ?? "").toLowerCase();
  return code === "cancelled" || code === "canceled" || code === "postponed" ? "cancelled" : "active";
}

/** Mirrors lib/events/ticketmaster.ts's mapEvent() exactly — provider_event_id is event.id, untransformed. */
export function mapTicketmasterEvent(event, { destination, now }) {
  const id = event.id;
  const starts_at = event.dates?.start?.dateTime;
  if (!id || !event.name || !starts_at) return { row: null, reason: "invalid" };
  const startDate = new Date(starts_at);
  if (Number.isNaN(startDate.getTime())) return { row: null, reason: "invalid" };
  if (startDate.getTime() < now.getTime()) return { row: null, reason: "past" };

  const venue = event._embedded?.venues?.[0];
  const lat = venue?.location?.latitude != null ? Number(venue.location.latitude) : null;
  const lng = venue?.location?.longitude != null ? Number(venue.location.longitude) : null;
  const segmentName = event.classifications?.[0]?.segment?.name;
  // TODO family signal: TM's classifications[].family flag is unverified (no fixture / typed field here), so family_fit falls back to the keyword classifier.
  const price = event.priceRanges?.[0];

  const row = {
    provider: "ticketmaster",
    provider_event_id: id,
    name: event.name,
    description: bestTicketmasterDescription(event, { title: event.name }),
    category: categoryFromTicketmasterSegment(segmentName),
    // Ticketmaster API fields — drop anything that isn't http(s) before it
    // lands in the DB (see scripts/lib/http-url.mjs).
    image_url: httpUrlOrNull(pickTmImage(event.images)),
    ticket_url: httpUrlOrNull(event.url ?? null),
    starts_at,
    ends_at: null,
    venue_name: venue?.name ?? null,
    address: [venue?.address?.line1, venue?.city?.name].filter(Boolean).join(", ") || null,
    lat: lat != null && Number.isFinite(lat) ? lat : null,
    lng: lng != null && Number.isFinite(lng) ? lng : null,
    city: venue?.city?.name ?? null,
    country: venue?.country?.countryCode ?? null,
    is_free: null,
    price_from: typeof price?.min === "number" ? price.min : null,
    currency: price?.currency ?? null,
    destination,
    source: "api",
    status: ticketmasterStatus(event),
    fetched_at: now.toISOString(),
  };
  return { row, reason: null };
}

export function toTmDateTime(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function run({ now }) {
  const provider = "ticketmaster";
  const stats = emptyStats();
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) {
    console.log(`  [${provider}] SKIPPED (no TICKETMASTER_API_KEY in env)`);
    return { provider, rows: [], stats };
  }

  const startDateTime = toTmDateTime(now);
  const endDateTime = toTmDateTime(new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000));
  const size = 100;
  const MAX_PAGES = 30;
  let rows = [];
  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
    const params = new URLSearchParams({
      apikey: apiKey,
      geoPoint: encodeGeohash(EDINBURGH_CENTER.lat, EDINBURGH_CENTER.lng, 9),
      radius: String(Math.round(PROACTIVE_RADIUS_MILES * 1.60934)), // TM's `unit` param below is km
      unit: "km",
      size: String(size),
      page: String(pageNum),
      sort: "date,asc",
      startDateTime,
      endDateTime,
    });
    let res;
    try {
      res = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params.toString()}`);
    } catch (err) {
      console.error(`  [${provider}] page=${pageNum} -> network error: ${err.message}`);
      break;
    }
    if (!res.ok) {
      // TM returns 401/403 for a bad key — treated the same as "this source said no", no retry.
      console.log(`  [${provider}] page=${pageNum} -> HTTP ${res.status}`);
      break;
    }
    let data;
    try {
      data = await res.json();
    } catch (err) {
      console.error(`  [${provider}] page=${pageNum} -> bad JSON: ${err.message}`);
      break;
    }
    stats.fetched += 1;
    const events = data._embedded?.events ?? [];
    for (const e of events) {
      stats.parsed += 1;
      const { row, reason } = mapTicketmasterEvent(e, { destination: DESTINATION, now });
      if (!row) {
        if (reason === "past") stats.skipped.past += 1;
        else stats.skipped.invalid += 1;
        continue;
      }
      if (isOffWedge(row)) {
        stats.skipped.offWedge += 1;
        console.log(`    [${provider}] off-wedge, skipped: "${row.name}" @ ${row.starts_at}`);
        continue;
      }
      CATEGORY_STATS.before[row.category ?? "other"] = (CATEGORY_STATS.before[row.category ?? "other"] ?? 0) + 1;
      row.category = classifyCategory(row);
      CATEGORY_STATS.after[row.category ?? "other"] = (CATEGORY_STATS.after[row.category ?? "other"] ?? 0) + 1;
      rows.push(row);
      stats.kept += 1;
    }
    const totalPages = data.page?.totalPages ?? 1;
    if (pageNum + 1 >= totalPages || events.length === 0) break;
  }
  rows = dedupeWithinSource(rows);
  return { provider, rows, stats };
}

export default {
  name: "ticketmaster",
  cadence: "daily",
  status: "live",
  run,
};
