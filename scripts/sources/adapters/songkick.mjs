/**
 * songkick adapter — Songkick Edinburgh metro area (gigs; 24551 — 24542 is Birmingham; schema.org JSON-LD, no auth).
 */

import { DESTINATION } from "../core/config.mjs";
import { fetchAndExtract } from "../core/jsonld.mjs";
import { dedupeWithinSource } from "../core/normalize.mjs";
import { emptyStats, mergeStats } from "../core/stats.mjs";

export default {
  name: "songkick",
  cadence: "daily",
  status: "live",
  async run({ now }) {
    const provider = "songkick";
    const pages = ["https://www.songkick.com/metro-areas/24551-uk-edinburgh"];
    let stats = emptyStats();
    let rows = [];
    for (const url of pages) {
      try {
        const r = await fetchAndExtract(url, { provider, destination: DESTINATION, now, requireEdinburgh: false });
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
