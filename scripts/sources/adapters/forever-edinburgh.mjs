/**
 * foreveredinburgh adapter — edinburgh.org (the city's official visitor site, "Forever Edinburgh")
 * `event` custom post type.
 *
 * The WP REST API (/wp-json/wp/v2/event) lists ~1000 events (incl. past) but carries NO dates, so each
 * event page is fetched and its dates read from structured markup:
 *
 *   <span data-event-start-date="25/10/2026" data-event-end-date="25/10/2026">
 *   <a data-analytics-address ...>Moonwake Beer Co, 6A Tower Street, Edinburgh, EH6 7BY</a>
 *   <div id="map" data-latitude="55.97" data-longitude="-3.16">
 *   price line next to the pound_sign icon, booking link a[data-analytics-booking_url]
 *
 * Times of day are NOT structured; they occasionally appear in the prose ("Running from 4pm to 6pm"). They
 * are only read for single-day events, from explicit phrases ("running/runs/starts ... TIME"), and only when
 * the page states exactly one start time. Otherwise the row is date-only (starts_at = T00:00:00Z, the
 * repo-wide "date only" sentinel, see isMidnightUtcSentinel).
 *
 * Cost control: the list API's `event_month-MM-YYYY` classes pre-filter to events touching the next
 * LOOKAHEAD window; only events modified in the last 365 days are considered; an event whose WP
 * `modified_gmt` is not newer than the stored row's fetched_at is NOT re-fetched (its stored row is
 * re-emitted); at most MAX_PAGE_FETCHES page fetches per run. Pages whose content hash matches the
 * page ledger also re-emit the stored row.
 *
 * Multi-day ranges become ONE row (starts_at = start, ends_at = end). Ranges longer than MAX_RANGE_DAYS
 * are permanent/seasonal attractions, not outings, and are skipped (counted under skipped.offWedge).
 */

import { cleanDescription, decodeHtmlEntities } from "../../lib/describe.mjs";
import { httpUrlOrNull } from "../../lib/http-url.mjs";
import { DESTINATION, LOOKAHEAD_DAYS } from "../core/config.mjs";
import { politeFetch } from "../core/fetch.mjs";
import { politeJson } from "../core/json-fetch.mjs";
import { canonicalUrl } from "../core/jsonld.mjs";
import { CATEGORY_STATS, classifyCategory, dedupeWithinSource, isOffWedge } from "../core/normalize.mjs";
import { fetchProviderRows, hashText, isUnchanged, loadLedger, recordPages, reemitRow } from "../core/page-ledger.mjs";
import { emptyStats } from "../core/stats.mjs";
import { londonWallToIso } from "../core/wall-time.mjs";

export { londonWallToIso };

export const PROVIDER = "foreveredinburgh";
export const API_BASE = "https://edinburgh.org/wp-json/wp/v2/event";
export const MAX_PAGE_FETCHES = 200;
export const MAX_MODIFIED_AGE_DAYS = 365;
export const MAX_RANGE_DAYS = 120;
export const FREE_CATEGORY_ID = 880;

// event_category term id -> Fomo category slug (first match in this priority order wins).
const CATEGORY_PRIORITY = [
  [879, "music"],
  [877, "comedy"],
  [882, "festival"],
  [883, "sports"],
  [884, "food"],
  [881, "arts"],
  [878, "arts"],
  [876, "family"],
];

export function categoryFromTermIds(ids = []) {
  const set = new Set(ids);
  for (const [id, slug] of CATEGORY_PRIORITY) if (set.has(id)) return slug;
  return "other";
}

// --- page parsing (pure) -----------------------------------------------------

function collapse(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function stripTags(html) {
  return decodeHtmlEntities(String(html ?? "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "));
}

/** "25/10/2026" -> "2026-10-25" (validated), else null. */
export function parseSiteDate(s) {
  const m = String(s ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m.map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const TIME = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s?(am|pm)|(\d{1,2}):(\d{2})`;
const START_PHRASE_RE = new RegExp(
  String.raw`\b(?:running|runs|run|starts?|starting|begins?|beginning|kicks off|doors(?: open)?)\s+(?:from\s+|at\s+)?(?:${TIME})(?:\s*(?:to|-|–|until|till)\s*(?:${TIME}))?`,
  "gi"
);

/** Parse one time token match (groups offset into the TIME alternation) to "HH:MM" or null. */
function toHHMM(h12, m12, ap, h24, m24) {
  let h;
  let m;
  if (ap) {
    h = Number(h12);
    m = Number(m12 ?? 0);
    if (h < 1 || h > 12) return null;
    const pm = ap.toLowerCase() === "pm";
    h = (h % 12) + (pm ? 12 : 0);
  } else {
    h = Number(h24);
    m = Number(m24);
  }
  if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Explicit start (and optional end) time from prose, or null when absent or ambiguous
 * (two different start times stated). Returns { start: "HH:MM", end: "HH:MM"|null }.
 */
export function parseTimeFromText(text) {
  const t = collapse(text);
  const starts = new Map(); // start -> end|null
  START_PHRASE_RE.lastIndex = 0;
  let m;
  while ((m = START_PHRASE_RE.exec(t)) !== null) {
    // groups: 1-5 first time, 6-10 second time
    const start = toHHMM(m[1], m[2], m[3], m[4], m[5]);
    const end = m[6] || m[9] ? toHHMM(m[6], m[7], m[8], m[9], m[10]) : null;
    if (!start) continue;
    if (!starts.has(start) || (end && !starts.get(start))) starts.set(start, end);
  }
  if (starts.size !== 1) return null;
  const [[start, end]] = [...starts.entries()];
  return { start, end: end && end > start ? end : null };
}

/** Price text -> { isFree, priceFrom } (lowest £ figure; "Free ..." alone is free). */
export function parsePriceText(priceText) {
  const t = collapse(priceText);
  if (!t) return { isFree: null, priceFrom: null };
  const figures = [...t.matchAll(/£\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, ""))).filter(Number.isFinite);
  if (figures.length > 0) {
    const min = Math.min(...figures);
    return { isFree: min === 0, priceFrom: min };
  }
  if (/\bfree\b/i.test(t)) return { isFree: true, priceFrom: 0 };
  return { isFree: null, priceFrom: null };
}

/** Extract everything the adapter needs from one event page's HTML. Pure. */
export function parseEventPage(html) {
  const dates = html.match(/data-event-start-date="([^"]*)"\s+data-event-end-date="([^"]*)"/);
  const startDate = dates ? parseSiteDate(dates[1]) : null;
  const endDate = dates ? parseSiteDate(dates[2]) : null;

  const addrM = html.match(/data-analytics-address[^>]*>\s*([\s\S]*?)\s*<\/a>/);
  const addrFull = addrM ? collapse(decodeHtmlEntities(addrM[1]).replace(/\r?\n/g, ", ").replace(/\s*,\s*,/g, ",")) : null;
  let venueName = null;
  let address = addrFull;
  if (addrFull) {
    const first = addrFull.split(",")[0].trim();
    if (first && !/^\d/.test(first) && addrFull.includes(",")) venueName = first;
  }

  const mapM = html.match(/id="map"[^>]*data-latitude="(-?[\d.]+)"[^>]*data-longitude="(-?[\d.]+)"/);
  const lat = mapM ? Number(mapM[1]) : null;
  const lng = mapM ? Number(mapM[2]) : null;

  const priceM = html.match(/pound_sign[\s\S]*?<span>\s*([\s\S]*?)\s*<\/span>/);
  const priceText = priceM ? collapse(decodeHtmlEntities(priceM[1])) : null;

  const bookM = html.match(/data-analytics-booking_url\s+href="([^"]+)"/);
  const bookingUrl = bookM ? decodeHtmlEntities(bookM[1]) : null;

  const ogImg = html.match(/property="og:image" content="([^"]+)"/);
  const ogDesc = html.match(/property="og:description" content="([^"]*)"/);

  const proseM = html.match(/<div[^>]*class="prose"[^>]*>([\s\S]*?)<\/div>\s*<\/section>/);
  const bodyText = proseM ? collapse(stripTags(proseM[1])) : "";

  return {
    startDate,
    endDate: endDate ?? startDate,
    venueName,
    address,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    priceText,
    bookingUrl,
    imageUrl: ogImg ? decodeHtmlEntities(ogImg[1]) : null,
    ogDescription: ogDesc ? collapse(decodeHtmlEntities(ogDesc[1])) : null,
    bodyText,
  };
}

/** Hash of the parts of a page that determine its row (ignores nav/markup churn). */
export function pageContentHash(parsed) {
  return hashText(
    [parsed.startDate, parsed.endDate, parsed.venueName, parsed.address, parsed.lat, parsed.lng, parsed.priceText, parsed.bookingUrl, parsed.bodyText]
      .map((x) => String(x ?? ""))
      .join("\n")
      .toLowerCase()
  );
}

// --- row building (pure) -----------------------------------------------------

/**
 * WP list item + parsed page -> { row } or { row:null, reason }.
 * reason: "invalid" (no usable dates) | "past" | "longRange".
 */
export function buildRow(item, parsed, { now }) {
  const name = collapse(decodeHtmlEntities(item.title?.rendered ?? ""));
  if (!name || !parsed.startDate) return { row: null, reason: "invalid" };

  const link = item.link;
  const providerEventId = canonicalUrl(link);
  const single = parsed.startDate === parsed.endDate;
  const todayIso = now.toISOString().slice(0, 10);
  if ((parsed.endDate ?? parsed.startDate) < todayIso) return { row: null, reason: "past" };

  const spanDays = (Date.parse(`${parsed.endDate}T00:00:00Z`) - Date.parse(`${parsed.startDate}T00:00:00Z`)) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) return { row: null, reason: "longRange" };

  let startsAt;
  let endsAt = null;
  const time = single ? parseTimeFromText(parsed.bodyText) : null;
  if (single && time) {
    startsAt = londonWallToIso(parsed.startDate, time.start);
    if (time.end) endsAt = londonWallToIso(parsed.startDate, time.end);
  } else {
    // Date-only: start sentinel (midnight UTC) and end of the last day, so a single-day event stays live all day.
    startsAt = `${parsed.startDate}T00:00:00.000Z`;
    endsAt = `${parsed.endDate}T23:59:59.000Z`;
  }

  const termIds = item.event_category ?? [];
  const { isFree: priceFree, priceFrom } = parsePriceText(parsed.priceText);
  const isFree = termIds.includes(FREE_CATEGORY_ID) ? true : priceFree;
  const media = item._embedded?.["wp:featuredmedia"]?.[0];
  const image = httpUrlOrNull(media?.source_url) ?? httpUrlOrNull(parsed.imageUrl);
  const bookingUrl = httpUrlOrNull(parsed.bookingUrl);

  const row = {
    provider: PROVIDER,
    provider_event_id: providerEventId,
    name,
    description: cleanDescription(parsed.bodyText || parsed.ogDescription, { title: name, venueName: parsed.venueName }),
    category: categoryFromTermIds(termIds),
    image_url: image,
    ticket_url: bookingUrl ?? httpUrlOrNull(link),
    starts_at: startsAt,
    ends_at: endsAt,
    venue_name: parsed.venueName,
    address: parsed.address,
    lat: parsed.lat,
    lng: parsed.lng,
    city: "Edinburgh",
    country: "GB",
    is_free: isFree,
    price_from: isFree && priceFrom == null ? 0 : priceFrom,
    currency: priceFrom != null && priceFrom > 0 ? "GBP" : null,
    destination: DESTINATION,
    source: "api",
    fetched_at: now.toISOString(),
  };
  return { row, reason: null };
}

// --- list API ------------------------------------------------------------------

/** Month keys ("MM-YYYY") touched by [now, now + LOOKAHEAD_DAYS]. */
export function lookaheadMonthKeys(now) {
  const keys = new Set();
  for (let d = 0; d <= LOOKAHEAD_DAYS; d += 1) {
    const t = new Date(now.getTime() + d * 86_400_000);
    keys.add(`${String(t.getUTCMonth() + 1).padStart(2, "0")}-${t.getUTCFullYear()}`);
  }
  return keys;
}

/** Candidate filter: modified within a year, and (when the item lists event_month classes) touching the lookahead months. */
export function isCandidate(item, now) {
  const modified = Date.parse(`${item.modified_gmt ?? item.modified}Z`);
  if (!Number.isFinite(modified) || now.getTime() - modified > MAX_MODIFIED_AGE_DAYS * 86_400_000) return false;
  const months = (item.class_list ?? []).filter((c) => c.startsWith("event_month-")).map((c) => c.slice("event_month-".length));
  if (months.length === 0) return true;
  const want = lookaheadMonthKeys(now);
  return months.some((m) => want.has(m));
}

async function listEvents(stats) {
  const items = [];
  for (let page = 1; page <= 30; page += 1) {
    const url = `${API_BASE}?per_page=100&page=${page}&_embed=wp:featuredmedia&_fields=id,link,modified_gmt,title,event_category,class_list,_embedded`;
    const r = await politeJson(url);
    if (!r.ok) {
      if (r.status === 400) break; // WP: page beyond the last one
      if (r.reason === "robots_disallowed" || r.reason === "robots_unavailable") stats.skipped.robots += 1;
      else stats.skipped.blocked += 1;
      console.log(`  [${PROVIDER}] list page ${page} -> ${r.reason}`);
      break;
    }
    if (!Array.isArray(r.data) || r.data.length === 0) break;
    stats.fetched += 1;
    items.push(...r.data);
    if (r.data.length < 100) break;
  }
  return items;
}

// --- adapter ---------------------------------------------------------------------

export default {
  name: "foreveredinburgh",
  cadence: "weekly",
  status: "shadow",
  async run({ now, write = false }) {
    const stats = emptyStats();
    const extra = { listed: 0, candidates: 0, pageFetches: 0, reemittedModified: 0, reemittedLedger: 0, capped: 0, longRange: 0, withTime: 0 };
    const rows = [];

    const all = await listEvents(stats);
    extra.listed = all.length;
    const candidates = all.filter((it) => isCandidate(it, now));
    extra.candidates = candidates.length;

    const existing = new Map((await fetchProviderRows(PROVIDER, now)).map((r) => [r.provider_event_id, r]));
    await loadLedger(PROVIDER);
    const ledgerEntries = [];

    for (const item of candidates) {
      stats.parsed += 1;
      const id = canonicalUrl(item.link);
      const prev = existing.get(id);

      // Unchanged since our last fetch of this page: re-emit the stored row (so it keeps being "seen").
      if (prev?.fetched_at && Date.parse(`${item.modified_gmt}Z`) <= Date.parse(prev.fetched_at)) {
        rows.push(reemitRow(prev, now));
        extra.reemittedModified += 1;
        stats.kept += 1;
        continue;
      }
      if (extra.pageFetches >= MAX_PAGE_FETCHES) {
        extra.capped += 1;
        if (prev) {
          rows.push(reemitRow(prev, now));
          stats.kept += 1;
        }
        continue;
      }

      extra.pageFetches += 1;
      const res = await politeFetch(item.link);
      if (!res.ok) {
        if (res.reason === "robots_disallowed" || res.reason === "robots_unavailable") stats.skipped.robots += 1;
        else stats.skipped.blocked += 1;
        console.log(`  [${PROVIDER}] ${item.link} -> SKIPPED (${res.reason})`);
        if (prev) {
          rows.push(reemitRow(prev, now));
          stats.kept += 1;
        }
        continue;
      }
      stats.fetched += 1;

      const parsed = parseEventPage(res.html);
      const hash = pageContentHash(parsed);
      ledgerEntries.push({ url: item.link, source_id: PROVIDER, content_hash: hash, status: 200 });

      if (prev && isUnchanged(item.link, hash)) {
        rows.push(reemitRow(prev, now));
        extra.reemittedLedger += 1;
        stats.kept += 1;
        continue;
      }

      const { row, reason } = buildRow(item, parsed, { now });
      if (!row) {
        if (reason === "past") stats.skipped.past += 1;
        else if (reason === "longRange") {
          extra.longRange += 1;
          stats.skipped.offWedge += 1;
        } else stats.skipped.invalid += 1;
        continue;
      }
      if (isOffWedge(row)) {
        stats.skipped.offWedge += 1;
        continue;
      }
      CATEGORY_STATS.before[row.category ?? "other"] = (CATEGORY_STATS.before[row.category ?? "other"] ?? 0) + 1;
      row.category = classifyCategory(row);
      CATEGORY_STATS.after[row.category ?? "other"] = (CATEGORY_STATS.after[row.category ?? "other"] ?? 0) + 1;
      if (!row.starts_at.endsWith("T00:00:00.000Z")) extra.withTime += 1;
      rows.push(row);
      stats.kept += 1;
    }

    await recordPages(ledgerEntries, { write, now });
    console.log(`  [${PROVIDER}] ${JSON.stringify(extra)}`);
    return { provider: PROVIDER, rows: dedupeWithinSource(rows), stats };
  },
};
