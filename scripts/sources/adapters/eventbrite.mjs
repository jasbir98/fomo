/**
 * eventbrite adapter — Eventbrite Edinburgh discover pages (20/page; schema.org JSON-LD, no auth).
 */

import { DESTINATION } from "../core/config.mjs";
import { fetchAndExtract } from "../core/jsonld.mjs";
import { dedupeWithinSource } from "../core/normalize.mjs";
import { emptyStats, mergeStats } from "../core/stats.mjs";

export default {
  name: "eventbrite",
  cadence: "daily",
  status: "live",
  async run({ now }) {
    const provider = "eventbrite";
    const pages = [
      "https://www.eventbrite.co.uk/d/united-kingdom--edinburgh/free--events/",
      "https://www.eventbrite.co.uk/d/united-kingdom--edinburgh/free--events/?page=2",
      "https://www.eventbrite.co.uk/d/united-kingdom--edinburgh/events--this-weekend/",
    ];
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
