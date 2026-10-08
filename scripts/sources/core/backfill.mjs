/**
 * Description backfill: runs after cross-source merge, on whatever the
 * adapters + cleanDescription didn't already fill.
 */

import { cleanDescription, fallbackDescription, isMidnightUtcSentinel, extractMetaDescription } from "../../lib/describe.mjs";
import { isJunkDescription } from "../../lib/junk-description.mjs";
import { politeFetch } from "./fetch.mjs";
import { EVENT_TYPES, extractJsonLdBlocks, iterJsonObjects } from "./jsonld.mjs";
import { londonDateKey } from "./time.mjs";

// --- description backfill (fetch the event's own page) -----------------------
//
// Runs after cross-source merge, on whatever the adapters + cleanDescription
// didn't already fill: for each row with an empty/short description, fetch
// its own ticket_url page (through the same politeFetch — robots.txt,
// per-host rate limit, 20s timeout, challenge detection, all identical to
// the JSON-LD adapters) and read, in order: the page's own JSON-LD
// Event `description` -> `og:description` -> `<meta name="description">`.
// Capped at MAX_BACKFILL_FETCHES fetches per run so one run can't spiral
// into hundreds of extra requests against dozens of hosts.
//
// Opportunistically also fixes the "date-only source -> stored as midnight
// UTC -> displays as 01:00 during BST" issue (see isMidnightUtcSentinel):
// when a row's starts_at looks like that sentinel and the fetched page's own
// JSON-LD gives a startDate with a real time component for the same
// Europe/London calendar date, the more precise time replaces it.
export const MAX_BACKFILL_FETCHES = 150;
export const DESCRIPTION_MIN_LENGTH = 40; // matches the measurement threshold: "empty or very short (<40 chars)"

export function needsBackfill(row) {
  // A placeholder ("summary of the event", "TBC", ...) counts as empty.
  return (
    !row.description ||
    row.description.trim().length < DESCRIPTION_MIN_LENGTH ||
    isJunkDescription(row.description, row.name)
  );
}

/** Best-effort {description, startDate} from the first schema.org Event object found on an already-fetched page. */
export function extractEventJsonLdFields(html) {
  for (const block of extractJsonLdBlocks(html)) {
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    for (const obj of iterJsonObjects(parsed)) {
      const typeValue = obj["@type"];
      const types = Array.isArray(typeValue) ? typeValue : [typeValue];
      if (!types.some((t) => EVENT_TYPES.has(t))) continue;
      return {
        description: typeof obj.description === "string" ? obj.description : null,
        startDate: typeof obj.startDate === "string" ? obj.startDate : null,
      };
    }
  }
  return { description: null, startDate: null };
}

/** True if a JSON-LD startDate string carries an explicit time component (not just "YYYY-MM-DD"). */
export function startDateHasTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value.trim());
}

export async function backfillDescriptions(rows, now) {
  const stats = {
    candidates: 0,
    fetched: 0,
    fetchFailed: 0,
    robotsBlocked: 0,
    foundOnPage: 0,
    datesFixed: 0,
    fallbackUsed: 0,
    alreadyOk: 0,
  };
  const samples = [];

  let fetchesUsed = 0;
  for (const row of rows) {
    if (!needsBackfill(row)) {
      stats.alreadyOk += 1;
      continue;
    }
    stats.candidates += 1;

    if (row.ticket_url && fetchesUsed < MAX_BACKFILL_FETCHES) {
      fetchesUsed += 1;
      const before = row.description;
      const result = await politeFetch(row.ticket_url);
      if (!result.ok) {
        stats.fetchFailed += 1;
        if (result.reason === "robots_disallowed" || result.reason === "robots_unavailable") {
          stats.robotsBlocked += 1;
        }
      } else {
        stats.fetched += 1;
        const { description: ldDescription, startDate: ldStartDate } = extractEventJsonLdFields(result.html);
        const pageDescription =
          cleanDescription(ldDescription, { title: row.name, venueName: row.venue_name }) ??
          cleanDescription(extractMetaDescription(result.html), { title: row.name, venueName: row.venue_name });
        if (pageDescription) {
          row.description = pageDescription;
          stats.foundOnPage += 1;
        }

        // Opportunistic date-only -> real-time fix, only when the fetched
        // page's own startDate is for the same Europe/London calendar date
        // (never trust a different date off an unrelated JSON-LD block).
        if (isMidnightUtcSentinel(row.starts_at) && startDateHasTime(ldStartDate)) {
          const fixed = new Date(ldStartDate);
          if (!Number.isNaN(fixed.getTime()) && londonDateKey(fixed.toISOString()) === londonDateKey(row.starts_at)) {
            row.starts_at = fixed.toISOString();
            stats.datesFixed += 1;
          }
        }

        if (samples.length < 10 && row.description !== before) {
          samples.push({ provider: row.provider, name: row.name, before, after: row.description });
        }
      }
    }

    // Only the last resort: a short-but-real description found above (>=15
    // chars via cleanDescription, even if under the 40-char "backfill
    // worth attempting" trigger) is kept as-is, never replaced by the
    // fallback — the fallback is for rows with truly nothing, not for
    // trimming a legitimately short real description.
    // A placeholder that survived (shouldn't post-cleanDescription, but be
    // safe) is treated as empty rather than being stored.
    if (row.description && isJunkDescription(row.description, row.name)) row.description = null;
    if (!row.description) {
      row.description = fallbackDescription(row);
      stats.fallbackUsed += 1;
      if (samples.length < 10) {
        samples.push({ provider: row.provider, name: row.name, before: null, after: row.description, fallback: true });
      }
    }
  }

  return { stats, samples };
}
