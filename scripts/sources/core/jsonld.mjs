/**
 * schema.org Event JSON-LD extraction shared by the HTML-scraped adapters
 * (luma, eventbrite, songkick, allevents) and the description backfill.
 */

import { cleanDescription } from "../../lib/describe.mjs";
import { httpUrlOrNull } from "../../lib/http-url.mjs";
import { politeFetch } from "./fetch.mjs";
import { londonOffsetMinutes } from "./time.mjs";
import { CATEGORY_STATS, classifyCategory, isEdinburghRow, isOffWedge } from "./normalize.mjs";

// --- shared schema.org JSON-LD extraction (mirrors scraper/weekly_edinburgh.py) ---

export const JSON_LD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

export function extractJsonLdBlocks(html) {
  const blocks = [];
  let match;
  JSON_LD_RE.lastIndex = 0;
  while ((match = JSON_LD_RE.exec(html)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

export function* iterJsonObjects(value) {
  if (Array.isArray(value)) {
    for (const child of value) yield* iterJsonObjects(child);
  } else if (value && typeof value === "object") {
    yield value;
    for (const child of Object.values(value)) yield* iterJsonObjects(child);
  }
}

// Same vocabulary as scraper/weekly_edinburgh.py's EVENT_TYPES.
export const EVENT_TYPES = new Set([
  "Event",
  "ScreeningEvent",
  "MusicEvent",
  "TheaterEvent",
  "Festival",
  "SocialEvent",
  "SportsEvent",
  "ExhibitionEvent",
  "EducationEvent",
  "FoodEvent",
  "ComedyEvent",
  "DanceEvent",
  "VisualArtsEvent",
  "LiteraryEvent",
  "ChildrensEvent",
  "BusinessEvent",
  "SaleEvent",
  "PublicationEvent",
  "BroadcastEvent",
  "CourseInstance",
]);

// Heuristic @type -> Fomo EventCategory (lib/events/categories.ts's
// vocabulary: music | nightlife | festival | arts | comedy | sports | food |
// family | other). No "nightlife" schema.org type exists, so that slug is
// unreachable from JSON-LD alone — same as Skiddle/Ticketmaster's own
// mappers, which also never guess nightlife from provider data.
export const TYPE_TO_CATEGORY = {
  MusicEvent: "music",
  Festival: "festival",
  TheaterEvent: "arts",
  ExhibitionEvent: "arts",
  VisualArtsEvent: "arts",
  DanceEvent: "arts",
  LiteraryEvent: "arts",
  ComedyEvent: "comedy",
  SportsEvent: "sports",
  FoodEvent: "food",
  ChildrensEvent: "family",
};

export function categoryFromTypes(types) {
  for (const t of types) {
    if (TYPE_TO_CATEGORY[t]) return TYPE_TO_CATEGORY[t];
  }
  return "other";
}

export function isoFromJsonLd(value, { end = false } = {}) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T${end ? "23:59:59" : "00:00:00"}+00:00`;
  }
  // A datetime with no offset/Z is Europe/London wall time (every source here
  // is an Edinburgh listing). `new Date` would read it as the *host's* local
  // time — UTC on the GitHub Actions runner — which stored Songkick's
  // "19:00" gigs as 19:00Z and showed them at 20:00 all through BST.
  // Same correction parseSkiddleDate applies to Skiddle's bare dates.
  const bare = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (bare) {
    const [, y, mo, d, h, mi, s = "0"] = bare;
    const guessUtcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    const dt = new Date(guessUtcMs - londonOffsetMinutes(new Date(guessUtcMs)) * 60_000);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : trimmed;
}

/** Extract {isFree, priceFrom, currency} from a JSON-LD Event's top-level isAccessibleForFree + offers. */
export function parsePrice(obj) {
  if (obj.isAccessibleForFree === true || obj.isAccessibleForFree === "True" || obj.isAccessibleForFree === "https://schema.org/True") {
    return { isFree: true, priceFrom: 0, currency: null };
  }
  let offers = obj.offers;
  if (Array.isArray(offers)) offers = offers[0];
  if (!offers || typeof offers !== "object") return { isFree: null, priceFrom: null, currency: null };

  const rawPrice = offers.price ?? offers.lowPrice;
  // Some sites (Luma) send "gbp"; the app maps only upper-case codes to a symbol.
  const currency = typeof offers.priceCurrency === "string" && offers.priceCurrency.trim() ? offers.priceCurrency.trim().toUpperCase() : null;
  if (rawPrice == null) return { isFree: null, priceFrom: null, currency };
  const value = Number(rawPrice);
  if (!Number.isFinite(value)) return { isFree: null, priceFrom: null, currency };
  return { isFree: value === 0, priceFrom: value, currency: value === 0 ? null : currency };
}

export function addressFromLocation(location) {
  if (!location || typeof location !== "object") return { venueName: null, address: null, city: null, lat: null, lng: null };
  const venueName = typeof location.name === "string" ? location.name : null;
  let address = null;
  let city = null;
  const addr = location.address;
  if (typeof addr === "string") {
    address = addr;
  } else if (addr && typeof addr === "object") {
    city = typeof addr.addressLocality === "string" ? addr.addressLocality : null;
    address = [addr.streetAddress, addr.addressLocality, addr.postalCode].filter(Boolean).join(", ") || null;
  }
  let lat = null;
  let lng = null;
  const geo = location.geo;
  if (geo && typeof geo === "object") {
    const rawLat = geo.latitude;
    const rawLng = geo.longitude;
    if (rawLat != null && rawLng != null) {
      const nlat = Number(rawLat);
      const nlng = Number(rawLng);
      if (Number.isFinite(nlat) && Number.isFinite(nlng)) {
        lat = nlat;
        lng = nlng;
      }
    }
  }
  return { venueName, address, city, lat, lng };
}

export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    u.hostname = u.hostname.toLowerCase();
    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return `${u.protocol}//${u.hostname}${pathname}`;
  } catch {
    return url;
  }
}

/** schema.org `eventStatus` -> events.status. EventCancelled and EventPostponed both read as "cancelled"; everything else is "active". */
export function jsonLdStatus(obj) {
  const raw = Array.isArray(obj.eventStatus) ? obj.eventStatus.join(" ") : String(obj.eventStatus ?? "");
  return /EventCancelled|EventPostponed/i.test(raw) ? "cancelled" : "active";
}

/**
 * True when the JSON-LD says the event has no physical location: an
 * OnlineEventAttendanceMode, or a location that is only VirtualLocation(s).
 * A MixedEventAttendanceMode event, or a Place alongside a VirtualLocation,
 * is not online-only.
 */
export function jsonLdIsOnlineOnly(obj) {
  const mode = Array.isArray(obj.eventAttendanceMode) ? obj.eventAttendanceMode.join(" ") : String(obj.eventAttendanceMode ?? "");
  if (/OnlineEventAttendanceMode/i.test(mode) && !/Mixed/i.test(mode)) return true;
  const locations = Array.isArray(obj.location) ? obj.location : obj.location ? [obj.location] : [];
  if (locations.length === 0) return false;
  const isVirtual = (l) => {
    const t = l && typeof l === "object" ? l["@type"] : null;
    return (Array.isArray(t) ? t : [t]).includes("VirtualLocation");
  };
  return locations.every(isVirtual);
}

/**
 * Convert one schema.org Event JSON-LD object to a normalized `events` row,
 * or null if it's missing what's needed for a stable key. Never throws —
 * bad/partial JSON-LD is common and just means "skip this object".
 */
export function mapJsonLdEvent(obj, { provider, pageUrl, destination, now }) {
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const startsAtRaw = isoFromJsonLd(obj.startDate);
  if (!name || !startsAtRaw) return { row: null, reason: !name ? "no-name" : "no-start-date" };

  const startsAt = new Date(startsAtRaw);
  if (Number.isNaN(startsAt.getTime())) return { row: null, reason: "unparseable-start-date" };

  const endsAtRaw = isoFromJsonLd(obj.endDate, { end: true });
  const endsAt = endsAtRaw ? new Date(endsAtRaw) : null;
  const effectiveEnd = endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : startsAt;
  if (effectiveEnd.getTime() < now.getTime()) return { row: null, reason: "past" };

  const typeValue = obj["@type"];
  const types = Array.isArray(typeValue) ? typeValue : [typeValue];
  if (!types.some((t) => EVENT_TYPES.has(t))) return { row: null, reason: "not-an-event-type" };

  let eventUrl = typeof obj.url === "string" ? obj.url : typeof obj["@id"] === "string" ? obj["@id"] : pageUrl;
  try {
    eventUrl = new URL(eventUrl, pageUrl).toString();
  } catch {
    eventUrl = pageUrl;
  }
  const providerEventId = canonicalUrl(eventUrl);
  if (!providerEventId) return { row: null, reason: "no-stable-id" };

  const { venueName, address, city, lat, lng } = addressFromLocation(obj.location);
  const { isFree, priceFrom, currency } = parsePrice(obj);

  const row = {
    provider,
    provider_event_id: providerEventId,
    name,
    description: cleanDescription(obj.description, { title: name, venueName }),
    category: categoryFromTypes(types),
    // JSON-LD's `obj.url`/`obj.image` are untrusted third-party page
    // content — drop anything that isn't http(s) before it lands in the DB
    // (see scripts/lib/http-url.mjs; app-side readers also validate, but a
    // clean DB is the first line of defence).
    image_url: httpUrlOrNull(pickImage(obj.image)),
    ticket_url: httpUrlOrNull(eventUrl),
    starts_at: startsAt.toISOString(),
    ends_at: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt.toISOString() : null,
    venue_name: venueName,
    address,
    lat,
    lng,
    city,
    country: "GB",
    is_free: isFree,
    price_from: priceFrom,
    currency,
    destination,
    source: "api",
    status: jsonLdStatus(obj),
    fetched_at: now.toISOString(),
  };
  // Transient flag for core/validate.mjs (`online_only`); validateRow strips it
  // before the row can reach the DB. Only set when true.
  if (jsonLdIsOnlineOnly(obj)) row._online = true;
  return { row, reason: null };
}

export function pickImage(image) {
  if (typeof image === "string") return image;
  if (Array.isArray(image)) {
    const first = image.find((i) => typeof i === "string" || (i && typeof i === "object" && typeof i.url === "string"));
    if (typeof first === "string") return first;
    if (first && typeof first === "object") return first.url;
    return null;
  }
  if (image && typeof image === "object" && typeof image.url === "string") return image.url;
  return null;
}

/**
 * Fetch a page and extract normalized rows from its JSON-LD Event objects.
 * Returns per-page stats plus the rows. Never throws.
 */
export async function fetchAndExtract(url, { provider, destination, now, requireEdinburgh }) {
  const stats = { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0, offWedge: 0 } };
  const result = await politeFetch(url);
  if (!result.ok) {
    if (result.reason === "robots_disallowed" || result.reason === "robots_unavailable") {
      stats.skipped.robots += 1;
    } else {
      stats.skipped.blocked += 1;
    }
    console.log(`  [${provider}] ${url} -> SKIPPED (${result.reason})`);
    return { rows: [], stats };
  }
  stats.fetched += 1;

  const blocks = extractJsonLdBlocks(result.html);
  const rawObjects = [];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      rawObjects.push(...iterJsonObjects(parsed));
    } catch {
      // Malformed JSON-LD block — skip just this block, not the whole page.
      continue;
    }
  }

  const rows = [];
  for (const obj of rawObjects) {
    const typeValue = obj["@type"];
    const types = Array.isArray(typeValue) ? typeValue : [typeValue];
    if (!types.some((t) => EVENT_TYPES.has(t))) continue;
    stats.parsed += 1;

    const { row, reason } = mapJsonLdEvent(obj, { provider, pageUrl: result.finalUrl, destination, now });
    if (!row) {
      if (reason === "past") stats.skipped.past += 1;
      else stats.skipped.invalid += 1;
      continue;
    }
    if (requireEdinburgh && !isEdinburghRow(row)) {
      stats.skipped.notEdinburgh += 1;
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
  return { rows, stats };
}
