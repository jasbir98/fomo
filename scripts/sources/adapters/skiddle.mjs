/**
 * skiddle adapter — proactive, paginated pull of the Skiddle Events API
 * (/events/search/, needs SKIDDLE_API_KEY; skipped with a log line when absent).
 *
 * lib/events/skiddle.ts has the same field mapping for the app's live path:
 * provider_event_id (and every other column) comes out byte-identical to what
 * that path would write, but this adapter pages over a lookahead window
 * (PROACTIVE_LOOKAHEAD_DAYS) instead of a single capped page. The
 * (provider, provider_event_id) unique index means a re-discovered event
 * upserts onto the same row rather than duplicating it.
 */

import { cleanDescription } from "../../lib/describe.mjs";
import { httpUrlOrNull } from "../../lib/http-url.mjs";
import { DESTINATION, PROACTIVE_LOOKAHEAD_DAYS, PROACTIVE_RADIUS_MILES } from "../core/config.mjs";
import { CATEGORY_STATS, EDINBURGH_CENTER, classifyCategory, dedupeWithinSource, isOffWedge } from "../core/normalize.mjs";
import { emptyStats } from "../core/stats.mjs";
import { londonOffsetMinutes } from "../core/time.mjs";

export const SKIDDLE_EVENTCODE_MAP = {
  CLUB: "nightlife",
  LIVE: "music",
  FEST: "festival",
  THEATRE: "arts",
  ARTS: "arts",
  EXHIB: "arts",
  COMEDY: "comedy",
  DATE: "food",
  KIDS: "family",
  SPORT: "sports",
};
export function categoryFromSkiddleCode(raw) {
  if (!raw) return "other";
  return SKIDDLE_EVENTCODE_MAP[String(raw).toUpperCase().trim()] ?? "other";
}

const TICKETMASTER_SEGMENT_MAP = {
  Music: "music",
  Sports: "sports",
  "Arts & Theatre": "arts",
  Film: "arts",
  Miscellaneous: "other",
};
function categoryFromTicketmasterSegment(raw) {
  if (!raw) return "other";
  return TICKETMASTER_SEGMENT_MAP[String(raw).trim()] ?? "other";
}

// Same placeholder-image filter as lib/events/skiddle.ts's realSkiddleImage —
// Skiddle serves a generic "no photo" CDN graphic for events/venues with no
// uploaded image; treat it as no image rather than a usable photo.
const SKIDDLE_PLACEHOLDER_IMAGE = /\/assets\/default\d*\.png$/i;
export function realSkiddleImage(url) {
  if (!url || SKIDDLE_PLACEHOLDER_IMAGE.test(url)) return null;
  return url;
}

/**
 * Skiddle's docs describe dates as "YYYY-MM-DD HH:mm:ss" with no timezone
 * (UK local) — but the live /events/search/ response actually returns full
 * ISO 8601 with an explicit offset (e.g. "2026-10-01T19:00:00+00:00", and
 * that offset is genuinely the UTC instant, not a mislabeled local time —
 * verified against the live API: autumn evening gigs came back with a UTC
 * hour consistent with a ~7-8pm BST local start). Handle both: an explicit
 * offset/Z is trusted as-is (`new Date` parses it correctly regardless of
 * host timezone); only the undocumented-but-possible bare
 * "YYYY-MM-DD HH:mm:ss" form (no offset) is treated as Europe/London wall
 * time and converted, since `new Date("YYYY-MM-DDTHH:mm:ss")` would
 * otherwise silently parse as the *host* machine's local timezone.
 */
export function parseSkiddleDate(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  // First guess the wall-clock time is UTC, find what Europe/London offset
  // is in effect at that instant, then correct — self-consistent because
  // the offset only flips on DST transition dates at 1/2am local, never at
  // the same wall-clock reading under both offsets.
  const guessUtcMs = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetMin = londonOffsetMinutes(new Date(guessUtcMs));
  const dt = new Date(guessUtcMs - offsetMin * 60_000);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

export function parseSkiddlePrice(raw) {
  if (!raw) return { isFree: null, priceFrom: null };
  const trimmed = String(raw).trim();
  if (/free/i.test(trimmed)) return { isFree: true, priceFrom: 0 };
  const match = trimmed.match(/[\d.]+/);
  if (!match) return { isFree: null, priceFrom: null };
  const value = Number(match[0]);
  return { isFree: false, priceFrom: Number.isFinite(value) ? value : null };
}

/** Mirrors lib/events/skiddle.ts's mapEvent() exactly — same fields, same provider_event_id shape (String(event.id), no transformation). */
export function mapSkiddleEvent(event, { destination, now }) {
  const id = event.id != null ? String(event.id) : null;
  const starts_at = parseSkiddleDate(event.startdate);
  if (!id || !event.eventname || !starts_at) return { row: null, reason: "invalid" };
  const startDate = new Date(starts_at);
  const ends_at = parseSkiddleDate(event.enddate);
  const effectiveEnd = ends_at ? new Date(ends_at) : startDate;
  if (effectiveEnd.getTime() < now.getTime()) return { row: null, reason: "past" };

  const lat = event.venue?.latitude ?? event.latitude;
  const lng = event.venue?.longitude ?? event.longitude;
  const { isFree, priceFrom } = parseSkiddlePrice(event.entryprice);

  const row = {
    provider: "skiddle",
    provider_event_id: id,
    name: event.eventname,
    description: cleanDescription(event.description, { title: event.eventname, venueName: event.venue?.name }),
    category: categoryFromSkiddleCode(event.eventcode),
    // Skiddle API fields — drop anything that isn't http(s) before it lands
    // in the DB (see scripts/lib/http-url.mjs).
    image_url: httpUrlOrNull(realSkiddleImage(event.largeimageurl) ?? realSkiddleImage(event.imageurl)),
    ticket_url: httpUrlOrNull(event.link ?? event.admin?.link ?? null),
    starts_at,
    ends_at,
    venue_name: event.venue?.name ?? null,
    address: [event.venue?.address, event.venue?.town].filter(Boolean).join(", ") || null,
    lat: lat != null ? Number(lat) : null,
    lng: lng != null ? Number(lng) : null,
    city: event.venue?.town ?? null,
    country: "GB",
    is_free: isFree,
    price_from: priceFrom,
    currency: isFree ? null : event.currency ?? "GBP",
    destination,
    source: "api",
    fetched_at: now.toISOString(),
  };
  return { row, reason: null };
}

async function run({ now }) {
  const provider = "skiddle";
  const stats = emptyStats();
  const apiKey = process.env.SKIDDLE_API_KEY;
  if (!apiKey) {
    console.log(`  [${provider}] SKIPPED (no SKIDDLE_API_KEY in env)`);
    return { provider, rows: [], stats };
  }

  const minDate = now.toISOString().slice(0, 10);
  const maxDate = new Date(now.getTime() + PROACTIVE_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const limit = 100;
  const MAX_PAGES = 15; // safety cap: 1500 events, comfortably above Edinburgh's 60-day volume
  let rows = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      api_key: apiKey,
      latitude: String(EDINBURGH_CENTER.lat),
      longitude: String(EDINBURGH_CENTER.lng),
      radius: String(PROACTIVE_RADIUS_MILES),
      order: "date",
      description: "1",
      limit: String(limit),
      offset: String(offset),
      country: "GB",
      minDate,
      maxDate,
    });
    let res;
    try {
      res = await fetch(`https://www.skiddle.com/api/v1/events/search/?${params.toString()}`);
    } catch (err) {
      console.error(`  [${provider}] offset=${offset} -> network error: ${err.message}`);
      break;
    }
    if (!res.ok) {
      console.log(`  [${provider}] offset=${offset} -> HTTP ${res.status}`);
      break;
    }
    let data;
    try {
      data = await res.json();
    } catch (err) {
      console.error(`  [${provider}] offset=${offset} -> bad JSON: ${err.message}`);
      break;
    }
    if (data.error) {
      console.log(`  [${provider}] offset=${offset} -> api error: ${data.error}`);
      break;
    }
    stats.fetched += 1;
    const results = data.results ?? [];
    for (const e of results) {
      stats.parsed += 1;
      const { row, reason } = mapSkiddleEvent(e, { destination: DESTINATION, now });
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
    if (results.length < limit) break; // last page
    offset += limit;
  }
  rows = dedupeWithinSource(rows);
  return { provider, rows, stats };
}

export default {
  name: "skiddle",
  cadence: "daily",
  status: "live",
  run,
};
