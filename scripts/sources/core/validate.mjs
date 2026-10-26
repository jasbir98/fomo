/**
 * Central row validation for scripts/daily-sources.mjs. Every row from every
 * adapter (live or shadow) goes through validateRow() in the orchestrator, so
 * new adapters get it for free.
 *
 * Pure: no network, no DB. validateRow(row, { now }) -> { ok, reason?, row }.
 *
 * Hard rejects (each counted by reason in the run summary and in
 * event_source_runs.rejected):
 *   missing_name   no usable title
 *   missing_start  no/unparseable starts_at
 *   bad_url        ticket_url present but not http(s)
 *   junk_title     fewer than two letters/digits (symbols-only, single char; "1984" is fine),
 *                  "test event", or the title is just the venue name
 *   online_only    JSON-LD VirtualLocation / "online", "livestream", "zoom"... as the location
 *   self_guided    a product, not an event: audio/GPS/app tours, self-guided trails, outdoor
 *                  escape games ("Edinburgh Audio Tour: Echoes of Intrigue" — Skiddle lists one
 *                  row per day, every day, so ~700 of them sat in the feed)
 *   past           event (or its end) is already over
 *   beyond_window  starts after now + LOOKAHEAD_DAYS
 *   end_before_start
 *   not_edinburgh  fails isEdinburghRow (geo within 15km, or a locality name); a row with no
 *                  location data at all passes only if its title names a locality
 *
 * Soft fixes (row kept): HTML entities decoded and whitespace collapsed in
 * name/venue_name, a non-http image_url becomes null, an unparseable ends_at
 * becomes null, the transient `_online` flag is stripped.
 */

import { decodeHtmlEntities } from "../../lib/describe.mjs";
import { LOOKAHEAD_DAYS } from "./config.mjs";
import { isEdinburghRow, namesEdinburghLocality } from "./normalize.mjs";

export const REJECT_REASONS = [
  "missing_name",
  "missing_start",
  "bad_url",
  "junk_title",
  "online_only",
  "self_guided",
  "past",
  "beyond_window",
  "end_before_start",
  "not_edinburgh",
];

const DAY_MS = 24 * 60 * 60 * 1000;

export function cleanText(value) {
  if (typeof value !== "string") return value ?? null;
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

function isHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Lowercase, strip everything but letters/digits — for "title equals venue" comparisons. */
function fold(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function isJunkTitle(name, venueName) {
  const t = String(name ?? "").trim();
  if (!t) return true;
  // Needs at least two letters/digits (any script): "1984" and "Up" are real
  // titles; "!!!", "?" and "-" are not.
  const alnum = t.match(/[\p{L}\p{N}]/gu) ?? [];
  if (alnum.length < 2) return true;
  if (/\btest\s+event\b/i.test(t)) return true;
  const f = fold(t);
  if (f.length > 0 && venueName && fold(venueName) === f) return true;
  return false;
}

// Venue/address words that say "this happens online", not at a place.
const ONLINE_LOCATION_RE = /\b(online|virtual|livestream|live\s*stream|zoom|webinar|microsoft\s+teams|google\s+meet)\b/i;
// A title that leads with, or is explicitly tagged as, an online-only event.
const ONLINE_TITLE_RE =
  /^\s*[[(]?\s*(online|virtual|livestream|live\s*stream|webinar)\b|[[(]\s*(online|virtual|zoom|webinar|livestream)\s*[\])]|\b(online|virtual)\s+(only|event|session|class|workshop|webinar|talk|meetup)\b|\bvia\s+zoom\b|\bon\s+zoom\b/i;

export function isOnlineOnly(row) {
  if (row._online) return true;
  if (row.venue_name && ONLINE_LOCATION_RE.test(row.venue_name)) return true;
  if (row.address && ONLINE_LOCATION_RE.test(row.address)) return true;
  // The title alone is a weaker signal; only trust it when there are no
  // physical coordinates to say otherwise.
  if ((row.lat == null || row.lng == null) && ONLINE_TITLE_RE.test(row.name ?? "")) return true;
  return false;
}

// Titles of things you buy and do on your own phone, any day, rather than
// turn up to: audio/GPS/app tours, self-guided trails, outdoor escape games,
// virtual tours. Title only: a real event's description can mention "an audio
// guide is available" without being one.
const SELF_GUIDED_TITLE_RE =
  /\baudio[- ]?(?:tour|guide|walk|trail)s?\b|\bself[- ]guided\b|\bgps[- ]?(?:treasure )?(?:guided|tour|trail|game|hunt)s?\b|\b(?:smartphone|phone|app)[- ](?:based|guided|tour|trail|game|treasure hunt|scavenger hunt)s?\b|\boutdoor escape (?:game|room)s?\b|\bvirtual (?:tour|walk)s?\b/i;

export function isSelfGuidedProduct(row) {
  return SELF_GUIDED_TITLE_RE.test(String(row.name ?? ""));
}

/**
 * isEdinburghRow, plus one carve-out: a row with NO location data at all (no
 * coordinates, city, address or venue — e.g. Luma hides the venue until you
 * register) passes only if its title names an Edinburgh locality. Anything
 * with real location data is judged by that data alone.
 */
export function isEdinburghOrUnlocatedButNamed(row) {
  if (isEdinburghRow(row)) return true;
  const unlocated = row.lat == null && row.lng == null && !row.city && !row.address && !row.venue_name;
  if (!unlocated) return false;
  return namesEdinburghLocality(row.name);
}

/**
 * Validate one row. Never mutates its input: on success `row` is a cleaned
 * copy (soft fixes applied, transient flags removed); on rejection `row` is the
 * original, untouched.
 */
export function validateRow(row, { now = new Date() } = {}) {
  const reject = (reason) => ({ ok: false, reason, row });

  const name = cleanText(row.name);
  if (!name) return reject("missing_name");

  const startMs = row.starts_at ? new Date(row.starts_at).getTime() : NaN;
  if (Number.isNaN(startMs)) return reject("missing_start");

  const cleaned = { ...row, name };
  delete cleaned._online;
  if (row.venue_name != null) cleaned.venue_name = cleanText(row.venue_name) || null;

  // URLs: a bad ticket_url rejects the row; a bad image_url is just dropped.
  if (cleaned.ticket_url != null && !isHttpUrl(cleaned.ticket_url)) return reject("bad_url");
  if (cleaned.image_url != null && !isHttpUrl(cleaned.image_url)) cleaned.image_url = null;

  if (isJunkTitle(name, cleaned.venue_name)) return reject("junk_title");
  if (isOnlineOnly(row)) return reject("online_only");
  if (isSelfGuidedProduct(cleaned)) return reject("self_guided");

  let endMs = null;
  if (cleaned.ends_at != null) {
    endMs = new Date(cleaned.ends_at).getTime();
    if (Number.isNaN(endMs)) {
      cleaned.ends_at = null;
      endMs = null;
    }
  }

  if ((endMs ?? startMs) < now.getTime()) return reject("past");
  if (startMs > now.getTime() + LOOKAHEAD_DAYS * DAY_MS) return reject("beyond_window");
  if (endMs != null && endMs < startMs) return reject("end_before_start");
  if (!isEdinburghOrUnlocatedButNamed(cleaned)) return reject("not_edinburgh");

  return { ok: true, row: cleaned };
}

/**
 * Validate a batch. Returns the kept rows plus `rejected`, a
 * { reason: count } map, and up to `sampleLimit` rejected examples per reason
 * (for the run summary).
 */
export function validateRows(rows, { now = new Date(), sampleLimit = 3 } = {}) {
  const kept = [];
  const rejected = {};
  const samples = {};
  for (const row of rows) {
    const result = validateRow(row, { now });
    if (result.ok) {
      kept.push(result.row);
      continue;
    }
    rejected[result.reason] = (rejected[result.reason] ?? 0) + 1;
    const list = (samples[result.reason] ??= []);
    if (list.length < sampleLimit) {
      list.push({ name: row.name, venue: row.venue_name ?? null, city: row.city ?? null, address: row.address ?? null, starts_at: row.starts_at ?? null });
    }
  }
  return { kept, rejected, samples };
}
