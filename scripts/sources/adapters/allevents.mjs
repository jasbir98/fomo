/**
 * allevents adapter — allevents.in Edinburgh listing (schema.org JSON-LD, no auth; leaks non-Edinburgh rows, geo-filtered).
 */

import { DESTINATION } from "../core/config.mjs";
import { fetchAndExtract } from "../core/jsonld.mjs";
import { dedupeWithinSource } from "../core/normalize.mjs";
import { emptyStats, mergeStats } from "../core/stats.mjs";

export default {
  name: "allevents",
  cadence: "daily",
  status: "live",
  async run({ now }) {
    const provider = "allevents";
    const pages = ["https://allevents.in/edinburgh/all"];
    let stats = emptyStats();
    let rows = [];
    for (const url of pages) {
      try {
        // allevents.in is known to leak non-Edinburgh rows onto this page —
        // geo-filter (lat/lng within 15km of Edinburgh centre, or a known
        // locality name in city/address) is required for this adapter only.
        const r = await fetchAndExtract(url, { provider, destination: DESTINATION, now, requireEdinburgh: true });
        stats = mergeStats(stats, r.stats);
        rows.push(...r.rows);
      } catch (err) {
        console.error(`  [${provider}] ${url} -> ERROR: ${err.message}`);
      }
    }
    rows = dedupeWithinSource(rows);
    return { provider, rows, stats };
  },
};
