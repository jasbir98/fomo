/**
 * edfestivals adapter — Edinburgh Festivals Listings API
 * (https://api.edinburghfestivalcity.com/documentation). Official, licensed
 * listings for Edinburgh's major festivals; one row per performance in the
 * lookahead window.
 *
 * Auth: every request carries `key` and `signature`. The signature is the
 * hex HMAC-SHA1 of the request path + query string (with `key` already
 * appended as the LAST parameter, `signature` excluded), keyed with the
 * secret — see /documentation/querying ("Authentication") and the official
 * PHP client's getSignedUrl(). Env: FESTIVALS_API_KEY, FESTIVALS_API_SECRET;
 * when either is absent the adapter logs a skip and returns no rows.
 *
 * Licence (https://api.edinburghfestivalcity.com/licence) duties this adapter
 * honours:
 *   - ticket_url is the API-provided `website` (never constructed; Fringe
 *     events deep-link to edfringe.com as the API supplies them).
 *   - Attribution + "not an official festival app" is rendered in
 *     components/detail/EventDetail.tsx when provider === "edfestivals".
 *   - Listings must be re-checked at least every 24h — this runs daily.
 *   - Images may only be shown alongside listings, never cropped.
 *
 * `demofringe` returns RANDOMISED test data, so it is never queried unless
 * FESTIVALS_INCLUDE_DEMOFRINGE=1 (and rows from it are not for production).
 * Live `fringe` data needs separate approval from the API owners; a refusal is
 * logged and the other festivals carry on.
 */

import { createHmac } from "node:crypto";
import { cleanDescription } from "../../lib/describe.mjs";
import { httpUrlOrNull } from "../../lib/http-url.mjs";
import { DESTINATION, LOOKAHEAD_DAYS } from "../core/config.mjs";
import { USER_AGENT } from "../core/fetch.mjs";
import { classifyCategory, dedupeWithinSource } from "../core/normalize.mjs";
import { emptyStats } from "../core/stats.mjs";
import { londonOffsetMinutes } from "../core/time.mjs";

const BASE_URL = "https://api.edinburghfestivalcity.com";
export const FESTIVAL_CODES = [
  "fringe",
  "jazz",
  "book",
  "international",
  "tattoo",
  "art",
  "hogmanay",
  "science",
  "imaginate",
  "film",
  "mela",
  "storytelling",
];
const PAGE_SIZE = 100; // API max
const MAX_PAGES = 15; // per festival+year
const REQUEST_GAP_MS = 400;
const REQUEST_TIMEOUT_MS = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// --- signing ---------------------------------------------------------------

/** Hex HMAC-SHA1 of `pathAndQuery` (path + query incl. `key=`, excl. `signature`) keyed with `secret`. */
export function signFestivalsRequest(pathAndQuery, secret) {
  return createHmac("sha1", secret).update(pathAndQuery, "utf8").digest("hex");
}

/**
 * Build a signed request URL. Params are urlencoded like PHP's
 * http_build_query (space -> "+"), `key` is appended last, then the signature
 * is computed over that exact string.
 */
export function buildSignedUrl(path, params, { key, secret, base = BASE_URL }) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) qs.append(k, String(v));
  qs.append("key", key);
  const pathAndQuery = `${path}?${qs.toString()}`;
  return `${base}${pathAndQuery}&signature=${signFestivalsRequest(pathAndQuery, secret)}`;
}

// --- time ------------------------------------------------------------------

/** "YYYY-MM-DD HH:mm:ss" in Europe/London for the API's date_from/date_to. */
export function londonWallClock(date) {
  const shifted = new Date(date.getTime() + londonOffsetMinutes(date) * 60_000);
  return shifted.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Performance start/end -> UTC ISO. The API gives Europe/London wall-clock
 * ("2026-12-31 20:00:00"); an explicit offset/Z is trusted as-is.
 */
export function parseFestivalsDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", sec = "0"] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
  const dt = new Date(guess - londonOffsetMinutes(new Date(guess)) * 60_000);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/** Festival year rolls over on 15 January (so Hogmanay belongs to the year it starts in). */
export function festivalYearFor(date) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  return m === 0 && d < 15 ? y - 1 : y;
}

// --- mapping ---------------------------------------------------------------

const FESTIVAL_DEFAULT_CATEGORY = {
  jazz: "music",
  book: "arts",
  international: "arts",
  art: "arts",
  film: "arts",
  fringe: "arts",
  demofringe: "arts",
  imaginate: "family",
  tattoo: "festival",
  hogmanay: "festival",
  mela: "festival",
  storytelling: "arts",
  science: "other",
};

const GENRE_RULES = [
  [/comedy|stand-?up|satire|improv/i, "comedy"],
  [/children|family|kids|young people|puppet|babies|toddler/i, "family"],
  [/music|jazz|blues|folk|classical|opera|concert|gig|choral|orchestra|band|singer|rock|pop|electronic|world music|soul|swing/i, "music"],
  [/club|party|dj\b/i, "nightlife"],
  [/food|drink|dining|tasting|whisky|beer|wine/i, "food"],
  [/sport|football|run\b|walk\b/i, "sports"],
  [/theatre|drama|dance|cabaret|circus|physical|musical|spoken word|poetry|storytelling|exhibition|visual art|film|book|talk|discussion|lecture|workshop|literature|writing|art\b/i, "arts"],
];

export function categoryFromFestivalEvent(event) {
  const genres = [event.genre, ...(Array.isArray(event.genre_tags) ? event.genre_tags : [])].filter((g) => typeof g === "string").join(" ");
  for (const [re, cat] of GENRE_RULES) if (genres && re.test(genres)) return cat;
  return FESTIVAL_DEFAULT_CATEGORY[event.festival_id] ?? "festival";
}

/** Best usable image URL: prefer a hero, never an obviously tiny square; large-1024 over original for weight. */
export function pickFestivalImage(images) {
  if (!images || typeof images !== "object") return null;
  const list = Object.values(images).filter((i) => i && typeof i === "object");
  if (list.length === 0) return null;
  const score = (i) => (i.type === "hero" ? 2 : 0) + (i.orientation === "landscape" ? 1 : 0);
  list.sort((a, b) => score(b) - score(a));
  for (const img of list) {
    const v = img.versions ?? {};
    const url = v["large-1024"]?.url ?? v["medium-640"]?.url ?? v.original?.url;
    if (url) return String(url).startsWith("//") ? `https:${url}` : url;
  }
  return null;
}

const PWYC_RE = /pay[\s_-]*(what|as)|pwyc|pwyw|donation|name your price|by donation/i;
const FREE_RE = /^free$|\bfree\b/i;

/** Price interpretation for one performance: { isFree, priceFrom, payWhatYouCan }. */
export function festivalPrice(perf) {
  const type = String(perf?.price_type ?? "");
  const text = String(perf?.price_string ?? "");
  const num = perf?.price == null || perf.price === "" ? null : Number(perf.price);
  if (PWYC_RE.test(type) || PWYC_RE.test(text)) return { isFree: false, priceFrom: null, payWhatYouCan: true };
  if (FREE_RE.test(type) || (num === 0 && FREE_RE.test(text))) return { isFree: true, priceFrom: 0, payWhatYouCan: false };
  if (num != null && Number.isFinite(num) && num > 0) return { isFree: false, priceFrom: num, payWhatYouCan: false };
  return { isFree: null, priceFrom: null, payWhatYouCan: false };
}

/**
 * One API event -> rows (one per performance whose start is in [now, windowEnd]).
 * Returns { rows, reasons } where reasons counts skipped performances.
 */
export function mapFestivalEvent(event, { destination = DESTINATION, now, windowEnd }) {
  const reasons = { past: 0, invalid: 0 };
  const rows = [];
  if (!event || !event.id || !event.title) {
    reasons.invalid += 1;
    return { rows, reasons };
  }
  if (event.status === "cancelled" || event.status === "deleted") return { rows, reasons };

  const venue = event.venue ?? {};
  const lat = venue.position?.lat ?? event.latitude ?? null;
  const lng = venue.position?.lon ?? event.longitude ?? null;
  const address = [venue.address, venue.post_code].filter(Boolean).join(", ") || null;
  const image_url = httpUrlOrNull(pickFestivalImage(event.images));
  const ticket_url = httpUrlOrNull(event.website ?? null);
  const baseDescription = event.description || event.description_teaser || "";
  const category = categoryFromFestivalEvent(event);

  for (const perf of Array.isArray(event.performances) ? event.performances : []) {
    const starts_at = parseFestivalsDate(perf.start);
    if (!starts_at) {
      reasons.invalid += 1;
      continue;
    }
    const ends_at = parseFestivalsDate(perf.end);
    const startMs = new Date(starts_at).getTime();
    const effectiveEnd = ends_at ? new Date(ends_at).getTime() : startMs;
    if (effectiveEnd < now.getTime()) {
      reasons.past += 1;
      continue;
    }
    if (startMs > windowEnd.getTime()) continue; // beyond window: not an error, just later
    const { isFree, priceFrom, payWhatYouCan } = festivalPrice(perf);
    let description = cleanDescription(baseDescription, { title: event.title, venueName: venue.name }) || "";
    if (payWhatYouCan) description = description ? `Pay what you can. ${description}` : "Pay what you can.";
    rows.push({
      provider: "edfestivals",
      provider_event_id: `${event.id}:${starts_at}`,
      name: event.title,
      description: description || null,
      category,
      image_url,
      ticket_url,
      starts_at,
      ends_at,
      venue_name: venue.name ?? null,
      address,
      lat: lat != null && Number.isFinite(Number(lat)) ? Number(lat) : null,
      lng: lng != null && Number.isFinite(Number(lng)) ? Number(lng) : null,
      city: "Edinburgh",
      country: "GB",
      is_free: isFree,
      price_from: priceFrom,
      currency: isFree || priceFrom == null ? null : "GBP",
      destination,
      source: "api",
      fetched_at: now.toISOString(),
    });
  }
  return { rows, reasons };
}

// --- fetching --------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg = body && typeof body === "object" && body.error ? String(body.error) : `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return Array.isArray(body) ? body : [];
}

async function run({ now }) {
  const provider = "edfestivals";
  const stats = emptyStats();
  const key = process.env.FESTIVALS_API_KEY;
  const secret = process.env.FESTIVALS_API_SECRET;
  if (!key || !secret) {
    console.log(`  [${provider}] skipped: no FESTIVALS_API_KEY (and FESTIVALS_API_SECRET)`);
    return { provider, rows: [], stats };
  }

  const windowEnd = new Date(now.getTime() + LOOKAHEAD_DAYS * DAY_MS);
  const date_from = londonWallClock(now);
  const date_to = londonWallClock(windowEnd);
  const years = [...new Set([festivalYearFor(now), festivalYearFor(windowEnd)])];
  const codes = process.env.FESTIVALS_INCLUDE_DEMOFRINGE === "1" ? [...FESTIVAL_CODES, "demofringe"] : FESTIVAL_CODES;

  let rows = [];
  for (const festival of codes) {
    for (const year of years) {
      let from = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = buildSignedUrl("/events", { festival, year, date_from, date_to, size: PAGE_SIZE, from }, { key, secret });
        let events;
        try {
          events = await fetchPage(url);
        } catch (err) {
          if (festival === "fringe" && (err.status === 401 || err.status === 403)) {
            console.log(`  [${provider}] fringe not available to this key (${err.message}) — needs Fringe approval; continuing`);
          } else {
            console.error(`  [${provider}] ${festival}/${year} from=${from} -> ${err.message}`);
            stats.skipped.blocked += 1;
          }
          break;
        }
        stats.fetched += 1;
        for (const event of events) {
          stats.parsed += 1;
          const { rows: mapped, reasons } = mapFestivalEvent(event, { now, windowEnd });
          stats.skipped.past += reasons.past;
          stats.skipped.invalid += reasons.invalid;
          for (const row of mapped) {
            row.category = classifyCategory(row);
            rows.push(row);
            stats.kept += 1;
          }
        }
        await sleep(REQUEST_GAP_MS);
        if (events.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
    }
  }
  rows = dedupeWithinSource(rows);
  return { provider, rows, stats };
}

export default {
  name: "edfestivals",
  cadence: "daily",
  status: "shadow",
  run,
};
