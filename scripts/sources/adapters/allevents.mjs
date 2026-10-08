/**
 * allevents adapter — allevents.in Edinburgh listings (schema.org JSON-LD, no auth; leaks non-Edinburgh rows, geo-filtered).
 *
 * Seeds: `/edinburgh/all` (up to 12 pages), `/edinburgh/free-events` (up to 3).
 * `comedy`, `workshops` and `this-weekend` were dropped: after the deeper `all`
 * pages they added 0 new events (comedy, workshops) or 1 (this-weekend).
 * `music` and `parties` were probed earlier and left out (mostly overlap).
 * A seed stops after two consecutive pages add no new ids. 15 page fetches per
 * run, hard cap. Any blocked skip stops the whole adapter for this run.
 */

import { DESTINATION } from "../core/config.mjs";
import { fetchAndExtract } from "../core/jsonld.mjs";
import { dedupeWithinSource } from "../core/normalize.mjs";
import { emptyStats, mergeStats } from "../core/stats.mjs";

const HOST = "https://allevents.in";
const MAX_PAGE_FETCHES = 15;
const STALE_PAGES_TO_STOP = 2;
const SEEDS = [
  { path: "/edinburgh/all", maxPages: 12 },
  { path: "/edinburgh/free-events", maxPages: 3 },
];

export default {
  name: "allevents",
  cadence: "daily",
  status: "live",
  async run({ now }) {
    const provider = "allevents";
    let stats = emptyStats();
    let rows = [];
    const seenIds = new Set();
    let pageFetches = 0;

    outer: for (const seed of SEEDS) {
      let stale = 0;
      for (let n = 1; n <= seed.maxPages; n += 1) {
        if (pageFetches >= MAX_PAGE_FETCHES) break outer;
        const url = n === 1 ? `${HOST}${seed.path}` : `${HOST}${seed.path}?page=${n}`;
        pageFetches += 1;
        // allevents.in is known to leak non-Edinburgh rows onto these pages —
        // geo-filter (lat/lng within 15km of Edinburgh centre, or a known
        // locality name in city/address) is required for this adapter only.
        let r;
        try {
          r = await fetchAndExtract(url, { provider, destination: DESTINATION, now, requireEdinburgh: true });
        } catch (err) {
          console.error(`  [${provider}] ${url} -> ERROR: ${err.message}`);
          break;
        }
        stats = mergeStats(stats, r.stats);
        if (r.stats.skipped.blocked > 0) {
          console.log(`  [${provider}] ${url} blocked; stopping the whole allevents adapter for this run`);
          break outer;
        }
        if (r.stats.fetched === 0) break; // robots-disallowed or error: move to the next seed

        let fresh = 0;
        for (const row of r.rows) {
          if (seenIds.has(row.provider_event_id)) continue;
          seenIds.add(row.provider_event_id);
          rows.push(row);
          fresh += 1;
        }
        console.log(`  [${provider}] ${seed.path}${n > 1 ? `?page=${n}` : ""}: kept=${r.rows.length} new=${fresh}`);
        stale = fresh === 0 ? stale + 1 : 0;
        if (stale >= STALE_PAGES_TO_STOP) break;
      }
    }

    rows = dedupeWithinSource(rows);
    console.log(`  [${provider}] page fetches=${pageFetches} unique rows=${rows.length}`);
    return { provider, rows, stats };
  },
};
