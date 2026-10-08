/**
 * Generic iCal (.ics) feed adapter. Config-driven like tribe-events.mjs: add a
 * feed by appending to ICAL_FEEDS and registering `makeIcalAdapter(config)`.
 * ICAL_FEEDS is empty, so nothing runs and nothing is registered yet.
 *
 * Minimal RFC 5545 support, enough for venue calendars:
 *   - line unfolding (CRLF/LF followed by a space or tab)
 *   - VEVENT: UID, SUMMARY, DESCRIPTION, URL, LOCATION, STATUS, DTSTART, DTEND
 *   - DTSTART/DTEND forms: `...TZID=Europe/London:YYYYMMDDTHHMMSS`, floating
 *     local time (treated as Europe/London), `...Z` UTC, and `VALUE=DATE`
 *     all-day (London midnight)
 *   - text unescaping (\n, \, \; \\)
 * Not supported (events are skipped and counted as invalid): RRULE expansion
 * (a recurring series would otherwise map to its first occurrence only),
 * RECURRENCE-ID overrides, and TZIDs other than Europe/London.
 *
 * Note: politeFetch treats any body under 5KB as an interstitial page, so a
 * very small feed would be reported as blocked.
 */

import { cleanDescription } from "../../lib/describe.mjs";
import { httpUrlOrNull } from "../../lib/http-url.mjs";
import { DESTINATION } from "../core/config.mjs";
import { politeFetch } from "../core/fetch.mjs";
import { isoFromJsonLd } from "../core/jsonld.mjs";
import { CATEGORY_STATS, classifyCategory, dedupeWithinSource, isOffWedge } from "../core/normalize.mjs";
import { emptyStats } from "../core/stats.mjs";

// Empty until a real feed is vetted. Shape:
// { provider, feedUrl, venue: { venue_name, address, city, lat, lng } }
export const ICAL_FEEDS = [];

// --- parsing ------------------------------------------------------------------------

/** RFC 5545 unfolding: a line starting with a space or tab continues the previous line. */
export function unfoldIcs(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length) {
      out[out.length - 1] += raw.slice(1);
    } else if (raw.length) {
      out.push(raw);
    }
  }
  return out;
}

/** Splits `NAME;PARAM=V:value` into {name, params, value}. Params keyed by upper-cased name. */
export function parseIcsProperty(line) {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(";");
  const params = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"(.*)"$/, "$1");
  }
  return { name: name.toUpperCase(), params, value };
}

/** RFC 5545 TEXT unescaping. */
export function unescapeIcsText(s) {
  return String(s ?? "").replace(/\\(.)/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

/**
 * DTSTART/DTEND value -> { iso, allDay } or null if unsupported/unparseable.
 * Local times are Europe/London wall time (via jsonld.mjs's conversion).
 */
export function icsDateToIso(value, params = {}) {
  const v = String(value ?? "").trim();
  const allDayForm = params.VALUE === "DATE" || /^\d{8}$/.test(v);
  if (allDayForm) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    const iso = isoFromJsonLd(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
    return iso ? { iso, allDay: true } : null;
  }
  const utc = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (utc) {
    const d = new Date(Date.UTC(+utc[1], +utc[2] - 1, +utc[3], +utc[4], +utc[5], +utc[6]));
    return Number.isNaN(d.getTime()) ? null : { iso: d.toISOString(), allDay: false };
  }
  const local = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!local) return null;
  const tzid = params.TZID;
  if (tzid && tzid !== "Europe/London") return null;
  const iso = isoFromJsonLd(`${local[1]}-${local[2]}-${local[3]}T${local[4]}:${local[5]}:${local[6]}`);
  return iso ? { iso, allDay: false } : null;
}

/** Parses the VEVENT blocks in an .ics document into plain objects (no mapping yet). */
export function parseIcsEvents(text) {
  const events = [];
  let current = null;
  for (const line of unfoldIcs(text)) {
    const prop = parseIcsProperty(line);
    if (!prop) continue;
    if (prop.name === "BEGIN" && prop.value.toUpperCase() === "VEVENT") {
      current = { props: {} };
      continue;
    }
    if (prop.name === "END" && prop.value.toUpperCase() === "VEVENT") {
      if (current) events.push(current.props);
      current = null;
      continue;
    }
    if (!current) continue;
    // Keep the first occurrence of each property; DTSTART/DTEND keep their params.
    if (!current.props[prop.name]) current.props[prop.name] = { params: prop.params, value: prop.value };
  }
  return events;
}

// --- mapping ------------------------------------------------------------------------

/** Maps one parsed VEVENT (from parseIcsEvents) to the `events` upsert shape, or {row:null, reason}. */
export function mapIcsEvent(props, { provider, venue, destination, now }) {
  const get = (k) => props[k]?.value;
  if (get("STATUS")?.toUpperCase() === "CANCELLED") return { row: null, reason: "invalid" };
  if (props.RRULE || props["RECURRENCE-ID"]) return { row: null, reason: "invalid" };

  const name = unescapeIcsText(get("SUMMARY")).replace(/\s+/g, " ").trim();
  const uid = get("UID")?.trim() || httpUrlOrNull(get("URL")) || null;
  if (!name || !uid || !props.DTSTART) return { row: null, reason: "invalid" };

  const start = icsDateToIso(get("DTSTART"), props.DTSTART.params);
  if (!start) return { row: null, reason: "invalid" };
  const startsAt = new Date(start.iso);
  if (startsAt.getTime() < now.getTime()) return { row: null, reason: "past" };

  const end = props.DTEND ? icsDateToIso(get("DTEND"), props.DTEND.params) : null;
  const endsAt = end ? new Date(end.iso) : null;

  const description = unescapeIcsText(get("DESCRIPTION"));
  const row = {
    provider,
    provider_event_id: uid,
    name,
    description: cleanDescription(description || null, { title: name, venueName: venue.venue_name }),
    category: "other",
    image_url: null, // iCal carries no reliable image property
    ticket_url: httpUrlOrNull(get("URL")),
    starts_at: startsAt.toISOString(),
    ends_at: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt.toISOString() : null,
    venue_name: venue.venue_name,
    address: venue.address ?? (get("LOCATION") ? unescapeIcsText(get("LOCATION")) : null),
    lat: venue.lat ?? null,
    lng: venue.lng ?? null,
    city: venue.city ?? "Edinburgh",
    country: "GB",
    is_free: null,
    price_from: null,
    currency: null,
    destination,
    source: "api",
    fetched_at: now.toISOString(),
  };
  return { row, reason: null };
}

// --- adapter ------------------------------------------------------------------------

export async function adapterIcalFeed(config, now) {
  const { provider, feedUrl, venue } = config;
  const stats = emptyStats();
  let rows = [];
  const result = await politeFetch(feedUrl);
  if (!result.ok) {
    if (result.reason === "robots_disallowed" || result.reason === "robots_unavailable") {
      stats.skipped.robots += 1;
    } else {
      stats.skipped.blocked += 1;
    }
    console.log(`  [${provider}] ${feedUrl} -> SKIPPED (${result.reason})`);
    return { provider, rows, stats };
  }
  stats.fetched += 1;

  for (const props of parseIcsEvents(result.html)) {
    stats.parsed += 1;
    const { row, reason } = mapIcsEvent(props, { provider, venue, destination: DESTINATION, now });
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
  rows = dedupeWithinSource(rows);
  return { provider, rows, stats };
}

export function makeIcalAdapter(config) {
  return {
    name: config.provider,
    cadence: "daily",
    status: "shadow",
    async run({ now }) {
      return adapterIcalFeed(config, now);
    },
  };
}
