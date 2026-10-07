/**
 * google-place-map.mjs — pure helpers that turn a Google Places API (New)
 * response into the columns Fomo stores on `places`, plus the match test that
 * decides whether a Text Search candidate really is our row.
 *
 * Shared by scripts/enrich-places-google.mjs. No I/O, no network, no `@/`
 * alias, so it runs under plain `node --test` — same constraint as
 * scripts/lib/place-match.mjs (which it imports for name matching).
 * See docs/plans/2026-10-07-data-enrichment.md §2.
 *
 * Two kinds of output column (plan §2):
 *   - "fills": our own fields (opening_hours, hours, address, lat, lng,
 *     price_level, google_place_id), written ONLY where the row is blank and
 *     kept forever.
 *   - "google": Google-owned facts (rating, review count, price range,
 *     website, phone, maps URI, summary, ...), always overwritten on refresh
 *     and cleared after 30 days (Google's caching terms).
 */

import { nameKey, nameTokens } from "./place-match.mjs";

export const EDINBURGH_CENTRE = { lat: 55.9533, lng: -3.1883 };
/** Max distance between our stored lat/lng and Google's for a match / "not moved". */
export const MAX_MATCH_METERS = 250;
/** Max distance from the city centre when we only know an address. */
export const MAX_ADDRESS_ONLY_METERS = 2000;

/** Google-owned columns on `places` (cleared after 30 days without a refresh). */
export const GOOGLE_OWNED_COLUMNS = [
  "rating",
  "google_rating_count",
  "price_range",
  "website",
  "phone",
  "google_maps_uri",
  "business_status",
  "google_summary",
  "google_summary_disclosure",
  "google_fetched_at",
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS_MAX_CHARS = 120;

const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (h, m) => `${pad2(h)}:${pad2(m ?? 0)}`;

function isBlank(value) {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------

/**
 * Google `regularOpeningHours.periods` -> our `[{ day, open, close }]`
 * (day 0 = Sunday, both Google and us; "HH:MM" 24h). A period that closes the
 * next day keeps its close time as-is ("18:00" -> "01:00" means 01:00 the
 * following morning, the convention documented on OpeningHoursPeriod).
 * A 24-hour place is returned by Google as a single open at day 0 00:00 with
 * no close: that becomes one 00:00–24:00 entry per day.
 * Returns [] when there is nothing usable.
 */
export function periodsToOpeningHours(regularOpeningHours) {
  const periods = regularOpeningHours?.periods;
  if (!Array.isArray(periods)) return [];
  const out = [];
  for (const p of periods) {
    const o = p?.open;
    if (!o || !Number.isInteger(o.day) || o.day < 0 || o.day > 6) continue;
    if (!p.close) {
      for (let day = 0; day <= 6; day += 1) out.push({ day, open: "00:00", close: "24:00" });
      continue;
    }
    out.push({ day: o.day, open: hhmm(o.hour ?? 0, o.minute), close: hhmm(p.close.hour ?? 0, p.close.minute) });
  }
  // A 24h place can only come out of the no-close branch; de-duplicate defensively.
  const seen = new Set();
  const unique = out.filter((e) => {
    const k = `${e.day}|${e.open}|${e.close}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => a.day - b.day || a.open.localeCompare(b.open));
  return unique;
}

function parseClock(token, inheritedMeridiem) {
  const m = token.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = (m[3] ?? inheritedMeridiem ?? "").toLowerCase();
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 24) {
    return null;
  }
  return { hour, minute, explicit: m[3] ? m[3].toLowerCase() : null };
}

// "10:00 AM – 5:00 PM" -> "10:00–17:00". Google sometimes drops the first
// meridiem ("10:00 – 11:30 PM"); infer it from the end time.
function parseRange(text) {
  const parts = text.split(/\s*[–—-]\s*|\s+to\s+/i);
  if (parts.length !== 2) return null;
  const end = parseClock(parts[1]);
  if (!end) return null;
  let start = parseClock(parts[0], null);
  if (!start) return null;
  if (!parts[0].match(/am|pm/i) && end.explicit) {
    // Borrow the end's meridiem; if that puts start after end, the start was the other half of the day.
    const flipped = end.explicit === "pm" ? "am" : "pm";
    const borrowed = parseClock(parts[0], end.explicit);
    const endMinutes = end.hour * 60 + end.minute;
    start = borrowed.hour * 60 + borrowed.minute <= endMinutes ? borrowed : parseClock(parts[0], flipped);
  }
  return `${hhmm(start.hour, start.minute)}–${hhmm(end.hour, end.minute)}`;
}

// One day's text after "Monday: " -> canonical string, or null if unparseable.
function parseDayHours(text) {
  const t = text.trim();
  if (/^closed$/i.test(t)) return "closed";
  if (/^open 24 hours$/i.test(t)) return "24h";
  const ranges = t.split(/\s*,\s*/).map(parseRange);
  if (ranges.length === 0 || ranges.some((r) => r == null)) return null;
  return ranges.join(" & ");
}

/**
 * Google `weekdayDescriptions` ("Monday: 10:00 AM – 5:00 PM", "Tuesday: Closed",
 * "Wednesday: Open 24 hours") -> short text:
 * "Mon–Fri 10:00–17:00, Sat–Sun 10:00–18:00". Consecutive days with identical
 * hours are grouped; closed days appear ("Tue closed") only when the week is
 * mixed. Same hours every day -> "Daily 10:00–17:00". Returns null when
 * anything is unparseable, the place is closed all week, or the result would
 * exceed 120 characters.
 */
export function compactHours(weekdayDescriptions) {
  if (!Array.isArray(weekdayDescriptions) || weekdayDescriptions.length === 0) return null;
  const byDay = new Map(); // day index (0 = Sunday) -> canonical hours
  for (const line of weekdayDescriptions) {
    if (typeof line !== "string") return null;
    const clean = line.replace(/[\u202f\u00a0\u2009]/g, " ").trim();
    const colon = clean.indexOf(":");
    if (colon < 1) return null;
    const dayIdx = DAY_NAMES.findIndex((d) => d.toLowerCase() === clean.slice(0, colon).trim().toLowerCase());
    if (dayIdx < 0) return null;
    const hours = parseDayHours(clean.slice(colon + 1));
    if (hours == null) return null;
    byDay.set(dayIdx, hours);
  }
  if (byDay.size === 0) return null;

  const monPos = (d) => (d + 6) % 7; // Mon = 0 .. Sun = 6
  // Walk Monday..Sunday and group runs of consecutive days with equal hours.
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => byDay.has(d));
  const groups = [];
  for (const d of order) {
    const last = groups[groups.length - 1];
    if (last && last.hours === byDay.get(d) && monPos(d) === monPos(last.days[last.days.length - 1]) + 1) {
      last.days.push(d);
    } else {
      groups.push({ hours: byDay.get(d), days: [d] });
    }
  }
  if (groups.every((g) => g.hours === "closed")) return null;

  const label = (g) => (g.days.length === 1 ? DAY_ABBR[g.days[0]] : `${DAY_ABBR[g.days[0]]}–${DAY_ABBR[g.days[g.days.length - 1]]}`);
  let text;
  if (groups.length === 1 && order.length === 7) {
    text = groups[0].hours === "24h" ? "Open 24 hours" : `Daily ${groups[0].hours}`;
  } else {
    text = groups.map((g) => `${label(g)} ${g.hours}`).join(", ");
  }
  return text.length <= HOURS_MAX_CHARS ? text : null;
}

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

const PRICE_LEVEL_MAP = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

/** Google's priceLevel enum string -> int 0–4 (same map as lib/places/google.ts), else null. */
export function priceLevelToInt(raw) {
  if (typeof raw !== "string") return null;
  return Object.prototype.hasOwnProperty.call(PRICE_LEVEL_MAP, raw) ? PRICE_LEVEL_MAP[raw] : null;
}

const CURRENCY_SYMBOLS = { GBP: "£", USD: "$", EUR: "€" };

function moneyUnits(money) {
  if (!money || money.units == null || money.units === "") return null;
  const n = Number(money.units);
  return Number.isFinite(n) ? n : null;
}

/**
 * Google priceRange { startPrice, endPrice } (Money: units as string,
 * currencyCode) -> "£10–20". Open-ended range (no endPrice) -> "£50+";
 * only an endPrice -> "Up to £20". Null when there is no usable price.
 */
export function priceRangeText(priceRange) {
  if (!priceRange) return null;
  const start = moneyUnits(priceRange.startPrice);
  const end = moneyUnits(priceRange.endPrice);
  const code = priceRange.startPrice?.currencyCode ?? priceRange.endPrice?.currencyCode ?? "GBP";
  const sym = CURRENCY_SYMBOLS[code] ?? `${code} `;
  if (start != null && end != null) return start === end ? `${sym}${start}` : `${sym}${start}–${end}`;
  if (start != null) return `${sym}${start}+`;
  if (end != null) return `Up to ${sym}${end}`;
  return null;
}

// ---------------------------------------------------------------------------
// Geometry + matching
// ---------------------------------------------------------------------------

/** Great-circle distance in metres between {lat,lng} points. */
export function haversineMeters(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const rowPoint = (row) => (isNum(row?.lat) && isNum(row?.lng) ? { lat: row.lat, lng: row.lng } : null);
const googlePoint = (g) =>
  isNum(g?.location?.latitude) && isNum(g?.location?.longitude)
    ? { lat: g.location.latitude, lng: g.location.longitude }
    : null;

const MAX_EXTRA_NAME_TOKENS = 4;

/**
 * Do two venue names refer to the same place? nameKey equality, or the shorter
 * is a whole-token prefix of the longer ("Camera Obscura" / "Camera Obscura &
 * World of Illusions"). A one-token prefix is only trusted when the token is
 * distinctive (>= 6 chars) AND the caller has coordinates to veto a
 * same-named venue elsewhere.
 */
export function namesMatch(a, b, { haveCoords = false } = {}) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  if (ta.join(" ") === tb.join(" ")) return true;
  // Same words in another order ("Cafe Jacques" / "Jacques Café"); two or more so a lone word can't pass.
  if (ta.length >= 2 && ta.length === tb.length && [...ta].sort().join(" ") === [...tb].sort().join(" ")) return true;
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (longer.length - shorter.length > MAX_EXTRA_NAME_TOKENS) return false;
  if (!shorter.every((t, i) => longer[i] === t)) return false;
  if (shorter.length >= 2) return true;
  return haveCoords && shorter[0].length >= 6;
}

/**
 * Is a Text Search candidate really our row? `candidate` is a Google place
 * ({ displayName: { text }, location: { latitude, longitude } }).
 * Names must match (see namesMatch) AND the candidate must be <= 250 m from the
 * row's lat/lng, or — when the row has no coordinates — <= 2 km from the
 * Edinburgh centre. Returns { ok, reason, distance } (distance in metres).
 */
export function acceptMatch(row, candidate) {
  const candName = candidate?.displayName?.text ?? candidate?.name ?? "";
  const point = rowPoint(row);
  if (!namesMatch(row?.name, candName, { haveCoords: Boolean(point) })) {
    return { ok: false, reason: `name mismatch: "${row?.name ?? ""}" vs "${candName}"`, distance: null };
  }
  const where = googlePoint(candidate);
  if (!where) return { ok: false, reason: "candidate has no location", distance: null };
  const origin = point ?? EDINBURGH_CENTRE;
  const limit = point ? MAX_MATCH_METERS : MAX_ADDRESS_ONLY_METERS;
  const distance = Math.round(haversineMeters(origin, where));
  if (distance > limit) {
    return { ok: false, reason: `too far: ${distance} m from ${point ? "stored location" : "Edinburgh centre"} (limit ${limit} m)`, distance };
  }
  return { ok: true, reason: `name match, ${distance} m from ${point ? "stored location" : "Edinburgh centre"}`, distance };
}

// ---------------------------------------------------------------------------
// Place Details -> column patch
// ---------------------------------------------------------------------------

function summaryOf(details) {
  const review = details?.reviewSummary?.text?.text;
  if (typeof review === "string" && review.trim()) {
    return { text: review.trim(), disclosure: details.reviewSummary.disclosureText?.text || "Summarized with Gemini" };
  }
  const generative = details?.generativeSummary?.overview?.text;
  if (typeof generative === "string" && generative.trim()) {
    return { text: generative.trim(), disclosure: details.generativeSummary.disclosureText?.text || "Summarized with Gemini" };
  }
  const editorial = details?.editorialSummary?.text;
  if (typeof editorial === "string" && editorial.trim()) return { text: editorial.trim(), disclosure: null };
  return { text: null, disclosure: null };
}

const normText = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const ADDRESS_ABBREV = { street: "st", road: "rd", avenue: "ave", place: "pl", lane: "ln", drive: "dr", square: "sq", terrace: "ter", crescent: "cres" };
const ADDRESS_NOISE = new Set(["uk", "united", "kingdom", "scotland", "edinburgh", "city", "of"]);

function addressTokens(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !ADDRESS_NOISE.has(t))
    .map((t) => ADDRESS_ABBREV[t] ?? t);
}

// Same address once abbreviations and city/country noise are ignored: the
// smaller token set must sit inside the larger ("50 George Street" vs
// "50 George St, Edinburgh EH2 2LE, UK").
function sameAddress(a, b) {
  const ta = addressTokens(a);
  const tb = addressTokens(b);
  if (ta.length === 0 || tb.length === 0) return true;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const bigSet = new Set(big);
  return small.every((t) => bigSet.has(t));
}

/**
 * Fields where Google disagrees with a value the row already has (address, lat,
 * lng, price_level, hours). Listed for review, never applied automatically.
 * Returns [{ field, current, google }].
 */
export function diffAgainstRow(row, details) {
  const changes = [];
  const g = googlePoint(details);
  const here = rowPoint(row);
  if (here && g && haversineMeters(here, g) > 50) {
    changes.push({ field: "lat", current: row.lat, google: g.lat });
    changes.push({ field: "lng", current: row.lng, google: g.lng });
  }
  if (!isBlank(row?.address) && !isBlank(details?.formattedAddress)) {
    if (!sameAddress(row.address, details.formattedAddress)) changes.push({ field: "address", current: row.address, google: details.formattedAddress });
  }
  const level = priceLevelToInt(details?.priceLevel);
  if (row?.price_level != null && level != null && row.price_level !== level) {
    changes.push({ field: "price_level", current: row.price_level, google: level });
  }
  const hours = compactHours(details?.regularOpeningHours?.weekdayDescriptions);
  if (!isBlank(row?.hours) && hours && normText(row.hours) !== normText(hours)) {
    changes.push({ field: "hours", current: row.hours, google: hours });
  }
  return changes;
}

/**
 * Decide what a Place Details response means for one `places` row.
 *   fills   — only fields currently null/empty on the row: opening_hours,
 *             hours, address, lat, lng, price_level, plus google_place_id when
 *             the row had none.
 *   google  — Google-owned fields, always (null when Google has no value).
 *   flags   — 'closed_permanently' | 'moved' (>250 m from stored lat/lng).
 *   changes — fields where Google differs from an existing value (review only).
 * `now` is a Date or ISO string used for google_fetched_at.
 */
export function buildPlacePatch(row, details, now) {
  const fills = {};
  const fillIf = (key, value) => {
    if (!isBlank(value) && isBlank(row?.[key])) fills[key] = value;
  };

  if (details?.id && isBlank(row?.google_place_id)) fills.google_place_id = details.id;
  fillIf("opening_hours", periodsToOpeningHours(details?.regularOpeningHours));
  fillIf("hours", compactHours(details?.regularOpeningHours?.weekdayDescriptions));
  fillIf("address", details?.formattedAddress);
  const g = googlePoint(details);
  if (g) {
    fillIf("lat", g.lat);
    fillIf("lng", g.lng);
  }
  fillIf("price_level", priceLevelToInt(details?.priceLevel));

  const summary = summaryOf(details);
  const google = {
    google_rating_count: isNum(details?.userRatingCount) ? details.userRatingCount : null,
    price_range: priceRangeText(details?.priceRange),
    website: details?.websiteUri || null,
    phone: details?.nationalPhoneNumber || null,
    google_maps_uri: details?.googleMapsUri || null,
    business_status: details?.businessStatus || null,
    google_summary: summary.text,
    google_summary_disclosure: summary.disclosure,
    google_fetched_at: new Date(now).toISOString(),
  };
  // Keep an existing rating when Google returns none rather than blanking it.
  if (isNum(details?.rating)) google.rating = details.rating;

  const flags = [];
  if (details?.businessStatus === "CLOSED_PERMANENTLY") flags.push("closed_permanently");
  const here = rowPoint(row);
  if (here && g && haversineMeters(here, g) > MAX_MATCH_METERS) flags.push("moved");

  return { fills, google, flags, changes: diffAgainstRow(row, details) };
}

export { nameKey };
