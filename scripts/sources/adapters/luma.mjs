/**
 * luma adapter — lu.ma/edinburgh listing page (tech/startup/networking; schema.org JSON-LD, no auth).
 */

import { DESTINATION } from "../core/config.mjs";
import { fetchAndExtract } from "../core/jsonld.mjs";
import { dedupeWithinSource } from "../core/normalize.mjs";
import { emptyStats, mergeStats } from "../core/stats.mjs";

export default {
  name: "luma",
  cadence: "daily",
  status: "live",
  async run({ now }) {
    const provider = "luma";
    const pages = ["https://lu.ma/edinburgh"];
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
