/**
 * Cross-source identity + dedupe. These helpers (normalizeEventTitle,
 * normalizeVenueKey, PROVIDER_PRIORITY) MUST stay in sync with
 * lib/events/identity.ts — the TS port the app uses for its read-time dedupe.
 * This module is plain .mjs run by node directly, so the two copies are edited
 * together by hand.
 */

import { londonDateKey, londonHourBucket } from "./time.mjs";

export function stripDiacritics(s) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/**
 * Normalize a title for cross-source identity matching: strip the trailing
 * venue/qualifier noise each source tacks onto the same event's name
 * differently ("Walter Trout // Edinburgh Queens Hall" vs "Walter Trout @
 * Queen's Hall" vs "Walter Trout - Edinburgh" vs "Walter Trout (Edinburgh)"),
 * fold accents (Angèle -> angele) so different sources' encodings of the same
 * name match, and collapse punctuation/whitespace. This runs on every row
 * before keying — JSON-LD sources and the Skiddle/Ticketmaster proactive
 * rows alike — so a gig discovered by both a scrape and a provider API
 * collapses onto one row too.
 */
// KEEP IN SYNC with lib/events/identity.ts (TS port used by the app's read-time dedupe).
export function normalizeEventTitle(name, venueName) {
  let t = stripDiacritics(String(name ?? "")).toLowerCase().trim();

  // Trailing "this is actually the venue/qualifier" patterns, in order.
  t = t.replace(/\s*\/\/\s*.+$/, ""); // " // Edinburgh Queens Hall"
  t = t.replace(/\s*@\s*.+$/, ""); // " @ Queen's Hall"
  t = t.replace(/\s*\|\s*.+$/, ""); // " | ..."
  t = t.replace(/\s*\(edinburgh\)\s*$/, ""); // " (Edinburgh)"
  t = t.replace(/\s*[-–—]\s*edinburgh\s*$/, ""); // " - Edinburgh"

  if (venueName) {
    const v = stripDiacritics(String(venueName)).toLowerCase().trim();
    if (v) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      t = t.replace(new RegExp(`\\s+at\\s+(the\\s+)?${escaped}\\s*$`), ""); // " at (the) Queen's Hall"
      t = t.replace(new RegExp(`\\s*[-–—]\\s*${escaped}\\s*$`), ""); // " - Queen's Hall"
    }
  }
  // Generic " at <venue>" trailing suffix when it wasn't already caught by
  // the row's own venue name above (e.g. venue_name missing/different casing).
  t = t.replace(/\s+at\s+the\s+\S.*$/, "");

  t = t
    .replace(/['’]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return t;
}

// "the", "at" and Edinburgh/UK boilerplate that different sources pad venue
// names with inconsistently ("The Queen's Hall" vs "Queen's Hall, Edinburgh")
// and which would otherwise make an identical venue fail to key-match.
export const VENUE_STOPWORDS = new Set(["the", "edinburgh", "uk", "scotland"]);

/**
 * Coarse venue identity for the cross-source key: same normalization as
 * normalizeEventTitle (diacritics/case/punctuation folded), minus stopwords,
 * so "The Queen's Hall" and "Queen's Hall, Edinburgh" match while "Edinburgh
 * Playhouse" and "Sheffield City Hall" (a touring show's two different
 * stops, same title, same/adjacent date) do not. Without this, a
 * title+date-only key would wrongly collapse distinct performances of a
 * touring production — different cities, or same city's matinee + evening
 * show on one date — onto a single row, silently dropping the other.
 */
export function normalizeVenueKey(venueName) {
  const folded = stripDiacritics(String(venueName ?? ""))
    .toLowerCase()
    .replace(/['’]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!folded) return "?"; // no venue info at all — never claim a false match on emptiness
  return folded
    .split(" ")
    .filter((w) => w && !VENUE_STOPWORDS.has(w))
    .join(" ");
}

/**
 * Identity key: normalized title + Europe/London calendar date + coarse
 * (3h) time bucket + coarse venue. Venue (rather than lat/lng) survives
 * slightly different geocoding between sources for the very same venue,
 * and the time bucket tells apart a same-day matinee vs evening show at
 * that same venue; either alone (title+date, or title+date+venue) would
 * incorrectly merge distinct performances of a touring production —
 * different cities on the same date, or the same city's two showtimes.
 */
export function crossSourceKey(row) {
  return `${normalizeEventTitle(row.name, row.venue_name)}|${londonDateKey(row.starts_at)}|${londonHourBucket(row.starts_at)}|${normalizeVenueKey(row.venue_name)}`;
}

// Preference order when two rows collapse onto the same key: the primary
// ticket sellers (Ticketmaster/Skiddle — official APIs) and Songkick (gig
// aggregator with its own canonical listing) outrank general discovery
// scrapes, which outrank allevents.in (known to leak non-Edinburgh rows —
// the noisiest/least precise source). sneakypetes (a single venue's
// own RSS feed) sits at the discovery-scrape tier; it was previously missing
// from this map and so defaulted to 0.
// KEEP IN SYNC with PROVIDER_PRIORITY in lib/events/identity.ts.
export const PROVIDER_PRIORITY = { ticketmaster: 3, skiddle: 3, edfestivals: 3, songkick: 2, foreveredinburgh: 2, jazzbar: 1, luma: 1, eventbrite: 1, sneakypetes: 1, voodoorooms: 1, allevents: 0 };

/** True if `candidate` should replace `existing` for the same cross-source key. */
export function isBetterRow(candidate, existing) {
  const cPrice = candidate.price_from != null;
  const ePrice = existing.price_from != null;
  if (cPrice !== ePrice) return cPrice;

  const cImage = candidate.image_url != null;
  const eImage = existing.image_url != null;
  if (cImage !== eImage) return cImage;

  const cUrl = candidate.ticket_url != null;
  const eUrl = existing.ticket_url != null;
  const cPri = PROVIDER_PRIORITY[candidate.provider] ?? 0;
  const ePri = PROVIDER_PRIORITY[existing.provider] ?? 0;
  if (cPri !== ePri) return cPri > ePri;
  if (cUrl !== eUrl) return cUrl;

  return false; // keep whichever was seen first
}

/** A structured kids signal on either copy of the same event survives the collapse. */
function keepFamilyFit(kept, dropped) {
  if (kept.family_fit == null && dropped.family_fit === "kids") return { ...kept, family_fit: "kids" };
  return kept;
}

/** Cross-source dedupe. Returns the deduped rows plus a log of every collapse (kept vs dropped) for reporting. */
export function dedupeAcrossSources(rows) {
  const best = new Map();
  const collapses = [];
  for (const row of rows) {
    const key = crossSourceKey(row);
    const existing = best.get(key);
    if (!existing) {
      best.set(key, row);
      continue;
    }
    if (isBetterRow(row, existing)) {
      collapses.push({ key, kept: row, dropped: existing });
      best.set(key, keepFamilyFit(row, existing));
    } else {
      collapses.push({ key, kept: existing, dropped: row });
      best.set(key, keepFamilyFit(existing, row));
    }
  }
  return { rows: Array.from(best.values()), collapses };
}
