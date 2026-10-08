/**
 * Generic adapter for WordPress "The Events Calendar" (Tribe) REST API:
 *   GET {baseUrl}/wp-json/tribe/events/v1/events?per_page=50&page=N&start_date=<today>
 * Pages are followed via the response's `next_rest_url` (cap MAX_PAGES).
 *
 * Config-driven: add a venue by appending to TRIBE_VENUES and exporting one
 * adapter object for it at the bottom (see `voodoorooms`). Every request goes
 * through politeFetch (robots.txt, per-host rate limit, timeout).
 *
 * Field notes (verified against thevoodoorooms.com, 2026-10-08):
 *   - start_date / end_date are venue-local (Europe/London) wall times;
 *     utc_start_date / utc_end_date are the UTC equivalents. We prefer the UTC
 *     fields and fall back to converting the local time via jsonld.mjs's
 *     isoFromJsonLd (Europe/London wall time -> UTC).
 *   - `cost` is a display string ("£10", "£13.00", "" or "Free").
 *   - `venue.venue` is the ROOM inside the building ("The Ballroom",
 *     "The Speakeasy"), not the venue. venue_name stays the building's name so
 *     the cross-source dedupe key (normalizeVenueKey) matches other sources;
 *     the room is folded into `address`.
 *   - `categories` is only FORTHCOMING/FEATURED on this site, so category comes
 *     from the keyword classifier (classifyCategory).
 */

import { cleanDescription } from "../../lib/describe.mjs";
import { httpUrlOrNull } from "../../lib/http-url.mjs";
import { DESTINATION } from "../core/config.mjs";
import { politeFetch } from "../core/fetch.mjs";
import { isoFromJsonLd } from "../core/jsonld.mjs";
import { CATEGORY_STATS, classifyCategory, dedupeWithinSource, isOffWedge } from "../core/normalize.mjs";
import { emptyStats } from "../core/stats.mjs";
import { londonDateKey } from "../core/time.mjs";

export const TRIBE_PAGE_SIZE = 50;
export const TRIBE_MAX_PAGES = 10;

export const TRIBE_VENUES = [
  {
    provider: "voodoorooms",
    baseUrl: "https://thevoodoorooms.com",
    // Source: thevoodoorooms.com/contact/ (address line; Google Maps marker
    // lat/long in the page's av_google_map script block).
    venue: {
      venue_name: "Voodoo Rooms",
      address: "19a West Register Street, Edinburgh, EH2 2AA",
      city: "Edinburgh",
      lat: 55.9537512,
      lng: -3.19063,
    },
  },
];

// --- small helpers -------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

function fromCodePoint(cp) {
  return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
}

/** Decodes numeric and common named HTML entities (titles carry e.g. `&#038;`, `&#8217;`). */
export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

/**
 * Parses Tribe's `cost` display string. "Free" -> isFree; "£10" / "£13.00" ->
 * priceFrom 10 / 13 (first number, so "£10 - £15" reads as from £10).
 */
export function parseTribeCost(cost) {
  const text = decodeEntities(cost).trim();
  if (!text) return { isFree: null, priceFrom: null, currency: null };
  if (/\bfree\b/i.test(text) && !/\d/.test(text)) return { isFree: true, priceFrom: 0, currency: null };
  const m = text.match(/(\d[\d,]*(?:\.\d+)?)/);
  if (!m) return { isFree: null, priceFrom: null, currency: null };
  const value = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return { isFree: null, priceFrom: null, currency: null };
  const currency = text.includes("£") ? "GBP" : null;
  return { isFree: value === 0, priceFrom: value, currency: value === 0 ? null : currency };
}

/** Tribe's UTC fields ("YYYY-MM-DD HH:MM:SS", UTC) -> ISO, else Europe/London local field -> ISO via jsonld's London conversion. */
export function tribeInstant(utc, local) {
  if (typeof utc === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(utc.trim())) {
    const d = new Date(`${utc.trim().replace(" ", "T")}Z`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof local === "string" && local.trim()) {
    return isoFromJsonLd(local.trim().replace(" ", "T"));
  }
  return null;
}

// --- mapping ----------------------------------------------------------------------

/** Maps one Tribe event to the `events` upsert shape, or {row:null, reason}. */
export function mapTribeEvent(event, { provider, venue, destination, now, baseUrl }) {
  if (event?.status && event.status !== "publish") return { row: null, reason: "invalid" };
  if (event?.hide_from_listings === true) return { row: null, reason: "invalid" };

  const name = decodeEntities(event?.title).replace(/\s+/g, " ").trim();
  const id = event?.id;
  if (!name || id == null) return { row: null, reason: "invalid" };

  const startsAtRaw = tribeInstant(event.utc_start_date, event.start_date);
  if (!startsAtRaw) return { row: null, reason: "invalid" };
  const startsAt = new Date(startsAtRaw);
  if (startsAt.getTime() < now.getTime()) return { row: null, reason: "past" };
  const endsAtRaw = tribeInstant(event.utc_end_date, event.end_date);
  const endsAt = endsAtRaw ? new Date(endsAtRaw) : null;

  // Prefer the venue's own permalink for ticket_url; the `website` field is
  // only used when the organiser set one (a ticket/booking link).
  const ticketUrl = httpUrlOrNull(event.website) ?? httpUrlOrNull(event.url) ?? httpUrlOrNull(baseUrl);
  const room = typeof event?.venue?.venue === "string" ? decodeEntities(event.venue.venue).trim() : "";
  const address = room && venue.address ? `${room}, ${venue.address}` : venue.address ?? null;
  const { isFree, priceFrom, currency } = parseTribeCost(event.cost);

  const row = {
    provider,
    provider_event_id: String(id),
    name,
    description: cleanDescription(event.description || event.excerpt || null, { title: name, venueName: venue.venue_name }),
    category: "other",
    image_url: httpUrlOrNull(event.image?.url ?? null),
    ticket_url: ticketUrl,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt.toISOString() : null,
    venue_name: venue.venue_name,
    address,
    lat: venue.lat ?? null,
    lng: venue.lng ?? null,
    city: venue.city ?? "Edinburgh",
    country: "GB",
    is_free: isFree,
    price_from: priceFrom,
    currency,
    destination,
    source: "api",
    fetched_at: now.toISOString(),
  };
  return { row, reason: null };
}

// --- adapter ----------------------------------------------------------------------

export async function adapterTribeEvents(config, now) {
  const { provider, baseUrl, venue } = config;
  const stats = emptyStats();
  let rows = [];
  const today = londonDateKey(now.toISOString());
  let url = `${baseUrl}/wp-json/tribe/events/v1/events?per_page=${TRIBE_PAGE_SIZE}&page=1&start_date=${today}`;

  for (let page = 1; url && page <= TRIBE_MAX_PAGES; page++) {
    const result = await politeFetch(url);
    if (!result.ok) {
      if (result.reason === "robots_disallowed" || result.reason === "robots_unavailable") {
        stats.skipped.robots += 1;
      } else {
        stats.skipped.blocked += 1;
      }
      console.log(`  [${provider}] ${url} -> SKIPPED (${result.reason})`);
      break;
    }
    stats.fetched += 1;

    let payload;
    try {
      payload = JSON.parse(result.html);
    } catch {
      stats.skipped.invalid += 1;
      console.log(`  [${provider}] ${url} -> SKIPPED (response is not JSON)`);
      break;
    }

    for (const event of Array.isArray(payload?.events) ? payload.events : []) {
      stats.parsed += 1;
      const { row, reason } = mapTribeEvent(event, { provider, venue, destination: DESTINATION, now, baseUrl });
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

    url = typeof payload?.next_rest_url === "string" && payload.next_rest_url ? payload.next_rest_url : null;
  }

  rows = dedupeWithinSource(rows);
  return { provider, rows, stats };
}

export function makeTribeAdapter(config) {
  return {
    name: config.provider,
    cadence: "daily",
    status: "shadow",
    async run({ now }) {
      return adapterTribeEvents(config, now);
    },
  };
}

export const voodoorooms = makeTribeAdapter(TRIBE_VENUES.find((v) => v.provider === "voodoorooms"));
