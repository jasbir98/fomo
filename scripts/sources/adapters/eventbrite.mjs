/**
 * eventbrite adapter — Eventbrite Edinburgh discover listings (20/page; schema.org JSON-LD, no auth).
 *
 * Listings are crawled in value order, all from one shared budget of
 * MAX_LISTING_FETCHES page fetches per run:
 *   free-this-week -> this-week -> next-week -> this-month -> next-month -> all-events
 * Date-scoped listings are used so the budget goes to in-window events.
 * Each listing pages until two consecutive pages add no new event ids, or it
 * hits MAX_PAGES_PER_LISTING (Eventbrite stops paging around 49).
 *
 * Eventbrite 429/403/405/401/503 or a challenge page stops the whole adapter
 * for this run (no retry, no bypass) and is recorded as `stats.skipped.blocked`.
 * Listing pages are spaced PAGE_GAP_MS apart on top of the core per-host floor.
 *
 * Dedupe across listings is on the numeric `-<digits>` event id. provider_event_id
 * is the canonical URL with the host pinned to www.eventbrite.co.uk, so the
 * .com/.sg variants Eventbrite serves map to the same row as existing .co.uk rows.
 */

import { DESTINATION } from "../core/config.mjs";
import { fetchAndExtract } from "../core/jsonld.mjs";
import { dedupeWithinSource } from "../core/normalize.mjs";
import { emptyStats, mergeStats } from "../core/stats.mjs";

const BASE = "https://www.eventbrite.co.uk/d/united-kingdom--edinburgh";
// Order matters: Eventbrite 429s us after ~35 listing pages per run, so the
// budget goes to the most productive listings first. Measured 8 Oct:
// all-events kept ~12.6 Edinburgh in-window rows per page; the date-scoped
// listings (events--this-week etc.) pull in Scotland-wide rows and kept ~6.
const LISTINGS = [
  "free--events",
  "all-events",
];
// Per-listing page caps (default MAX_PAGES_PER_LISTING): free first, briefly,
// so the cheap/free wedge is always covered before all-events uses the rest.
const LISTING_PAGE_CAP = { "free--events": 8 };
const MAX_LISTING_FETCHES = 40; // shared across listings, per run
const MAX_PAGES_PER_LISTING = 49;
const STALE_PAGES_TO_STOP = 2;
const PAGE_GAP_MS = 3000;
const WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const EB_HOST = "www.eventbrite.co.uk";
const BLOCKED_REASON = /HTTP (401|403|405|429|503)|blocked|challenged/;

const pause = () => new Promise((resolve) => setTimeout(resolve, PAGE_GAP_MS));

/** Numeric event id from the canonical URL (`.../e/<slug>-<digits>`); falls back to the full key. */
export function eventIdOf(row) {
  const key = row.provider_event_id ?? "";
  const m = /-(\d{6,})$/.exec(key);
  return m ? m[1] : key;
}

/**
 * Pin an Eventbrite canonical URL (from canonicalUrl) to www.eventbrite.co.uk.
 * Only the host changes; scheme, path and everything else stay as canonicalUrl left them.
 * Non-Eventbrite keys are returned unchanged.
 */
export function eventbriteProviderEventId(canonicalKey) {
  const m = /^(https?:\/\/)([^/]+)(\/.*)?$/i.exec(canonicalKey ?? "");
  if (!m || !/(^|\.)eventbrite\.[a-z.]+$/i.test(m[2])) return canonicalKey;
  return `${m[1]}${EB_HOST}${m[3] ?? ""}`;
}

export default {
  name: "eventbrite",
  cadence: "daily",
  status: "live",
  async run({ now }) {
    const provider = "eventbrite";
    const windowEnd = now.getTime() + WINDOW_MS;
    let stats = emptyStats();
    const rows = [];
    const seenIds = new Set();
    let inWindowIds = 0;
    let fetches = 0;

    outer: for (const listing of LISTINGS) {
      let stale = 0;
      let newIds = 0;
      let pagesRead = 0;
      for (let n = 1; n <= (LISTING_PAGE_CAP[listing] ?? MAX_PAGES_PER_LISTING); n += 1) {
        if (fetches >= MAX_LISTING_FETCHES) {
          console.log(`  [${provider}] listing budget (${MAX_LISTING_FETCHES}) used up at ${listing} page ${n}`);
          break outer;
        }
        fetches += 1;
        await pause();
        const url = `${BASE}/${listing}/?page=${n}`;
        const r = await fetchAndExtract(url, { provider, destination: DESTINATION, now, requireEdinburgh: false });
        stats = mergeStats(stats, r.stats);
        if (r.stats.skipped.blocked > 0) {
          console.log(`  [${provider}] ${listing} page ${n} blocked; stopping the whole Eventbrite adapter for this run`);
          break outer;
        }
        pagesRead += 1;

        let fresh = 0;
        for (const row of r.rows) {
          row.provider_event_id = eventbriteProviderEventId(row.provider_event_id);
          const id = eventIdOf(row);
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          rows.push(row);
          fresh += 1;
          if (Date.parse(row.starts_at) <= windowEnd) inWindowIds += 1;
        }
        newIds += fresh;
        stale = fresh === 0 ? stale + 1 : 0;
        if (stale >= STALE_PAGES_TO_STOP) break;
      }
      console.log(`  [${provider}] ${listing}: pages=${pagesRead} new_ids=${newIds} (distinct so far ${rows.length}, in-window ${inWindowIds})`);
    }

    const unique = dedupeWithinSource(rows);
    console.log(`  [${provider}] listing fetches=${fetches} distinct=${unique.length} in-window=${inWindowIds}`);
    return { provider, rows: unique, stats };
  },
};
