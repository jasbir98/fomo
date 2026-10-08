/**
 * songkick adapter — Songkick Edinburgh metro area (gigs; 24551 — 24542 is Birmingham; schema.org JSON-LD, no auth).
 *
 * Follows `?page=N` (50 events/page) up to 20 pages. The listing is date-sorted
 * ascending, so the walk stops as soon as a page's events all start beyond the
 * 31-day window, or a page adds no new ids, or a page has no events at all.
 */

import { DESTINATION } from "../core/config.mjs";
import { fetchAndExtract } from "../core/jsonld.mjs";
import { dedupeWithinSource } from "../core/normalize.mjs";
import { emptyStats, mergeStats } from "../core/stats.mjs";

const BASE = "https://www.songkick.com/metro-areas/24551-uk-edinburgh";
const MAX_PAGES = 20;
const WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

export default {
  name: "songkick",
  cadence: "daily",
  status: "live",
  async run({ now }) {
    const provider = "songkick";
    let stats = emptyStats();
    let rows = [];
    const seenIds = new Set();
    const horizon = now.getTime() + WINDOW_MS;

    for (let n = 1; n <= MAX_PAGES; n += 1) {
      const url = n === 1 ? BASE : `${BASE}?page=${n}`;
      let r;
      try {
        r = await fetchAndExtract(url, { provider, destination: DESTINATION, now, requireEdinburgh: false });
      } catch (err) {
        console.error(`  [${provider}] ${url} -> ERROR: ${err.message}`);
        break;
      }
      stats = mergeStats(stats, r.stats);
      if (r.stats.fetched === 0) break; // blocked / robots / error: stop paging this run
      if (r.stats.parsed === 0) break; // page has no events: end of listing

      let fresh = 0;
      for (const row of r.rows) {
        if (seenIds.has(row.provider_event_id)) continue;
        seenIds.add(row.provider_event_id);
        rows.push(row);
        fresh += 1;
      }
      if (r.rows.length > 0 && fresh === 0) break; // nothing new on this page
      if (r.rows.length > 0 && Math.min(...r.rows.map((row) => Date.parse(row.starts_at))) > horizon) break; // date-sorted: rest is beyond the window
    }

    rows = dedupeWithinSource(rows);
    return { provider, rows, stats };
  },
};
