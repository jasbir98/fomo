#!/usr/bin/env node
/**
 * check-happening-extractions.mjs -- the evidence gate between the extraction
 * agents and the database (step 4 of docs/plans/2026-10-07-data-enrichment.md).
 *
 * Reads, from --out-dir (e.g. scraper/out/enrich-2026-10-07):
 *   pages/<happening_id>.json    saved by scraper/fetch_happening_pages.py
 *   extract/batch-*.json         written by the extraction agents
 *
 * Extraction file format (one file per batch), an array of:
 *   {
 *     "id": "<happening uuid>",
 *     "fields": {
 *       "<field>": { "value": string|null, "quote": string|null, "url": string|null }
 *     }
 *   }
 * <field> is one of: price_text, includes, summary, time_note,
 * redemption_note, eligibility_note, venue_name, address.
 *   - value null = the page doesn't say; skipped.
 *   - quote = text copied verbatim from the saved page's "text".
 *   - url = the page the quote came from (defaults to the saved page's final_url).
 *
 * A field is accepted only if its quote appears in that row's saved page text
 * (lowercased, unicode quotes/dashes to ascii, whitespace collapsed, zero-width
 * chars stripped), every GBP figure in value appears in the quote, and the
 * value fits its length cap (summary 160, price_text 60, includes 160, others
 * 200). Em dashes in values are replaced by ", ". Rules live in
 * scripts/lib/extraction-gate.mjs (unit-tested).
 *
 * Writes into --out-dir:
 *   checked.json     { "<id>": { accepted: {field: {value, quote, url}},
 *                                rejected: {field: {reason, value, quote}} } }
 *   gate-report.md   counts per field and per rejection reason
 *
 * Reads local files only; no network, no database.
 *
 * Usage: node scripts/check-happening-extractions.mjs --out-dir scraper/out/enrich-2026-10-07
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FIELDS, gateExtraction } from "./lib/extraction-gate.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || !args.includes("--out-dir")) {
  console.log(`Usage: node scripts/check-happening-extractions.mjs --out-dir <dir>

<dir> must contain pages/*.json (from scraper/fetch_happening_pages.py) and
extract/batch-*.json (agent output). Writes checked.json and gate-report.md.
Extraction format is documented in this file's header.`);
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
}
const outDir = args[args.indexOf("--out-dir") + 1];

const pagesDir = join(outDir, "pages");
const extractDir = join(outDir, "extract");
if (!existsSync(pagesDir) || !existsSync(extractDir)) {
  console.error(`[check-extractions] need ${pagesDir} and ${extractDir}`);
  process.exit(1);
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const jsonFiles = (dir, re) => readdirSync(dir).filter((f) => re.test(f)).sort();

// Merge batches. A repeated id merges field-by-field, later batch wins.
const extractions = new Map();
for (const f of jsonFiles(extractDir, /^batch-.*\.json$/)) {
  let arr;
  try {
    arr = readJson(join(extractDir, f));
  } catch (err) {
    console.error(`[check-extractions] cannot parse ${f}: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(arr)) {
    console.error(`[check-extractions] ${f}: expected a JSON array`);
    process.exit(1);
  }
  for (const item of arr) {
    if (!item?.id) continue;
    const prev = extractions.get(item.id);
    extractions.set(item.id, { id: item.id, fields: { ...(prev?.fields ?? {}), ...(item.fields ?? {}) } });
  }
}

const checked = {};
const counts = Object.fromEntries(FIELDS.map((f) => [f, { proposed: 0, accepted: 0, rejected: 0 }]));
const reasons = new Map();
let rowsWithAccepted = 0;

for (const [id, extraction] of extractions) {
  const pagePath = join(pagesDir, `${id}.json`);
  const page = existsSync(pagePath) ? readJson(pagePath) : null;
  const { accepted, rejected } = gateExtraction(extraction, page);
  if (Object.keys(accepted).length === 0 && Object.keys(rejected).length === 0) continue;
  checked[id] = { accepted, rejected };
  if (Object.keys(accepted).length) rowsWithAccepted += 1;
  for (const field of Object.keys(accepted)) {
    counts[field].proposed += 1;
    counts[field].accepted += 1;
  }
  for (const [field, r] of Object.entries(rejected)) {
    const c = counts[field] ?? (counts[field] = { proposed: 0, accepted: 0, rejected: 0 });
    c.proposed += 1;
    c.rejected += 1;
    const key = r.reason.replace(/\d+/g, "N");
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
}

writeFileSync(join(outDir, "checked.json"), JSON.stringify(checked, null, 2));

const lines = [
  `# Evidence gate report`,
  ``,
  `Extractions read: ${extractions.size} row(s) from ${jsonFiles(extractDir, /^batch-.*\.json$/).length} batch file(s). Rows with at least one accepted field: ${rowsWithAccepted}.`,
  ``,
  `| Field | Proposed | Accepted | Rejected |`,
  `|---|---:|---:|---:|`,
  ...Object.entries(counts).map(([f, c]) => `| ${f} | ${c.proposed} | ${c.accepted} | ${c.rejected} |`),
  ``,
  `## Rejection reasons`,
  ``,
  ...(reasons.size ? [...reasons].sort((a, b) => b[1] - a[1]).map(([r, n]) => `- ${r}: ${n}`) : ["- none"]),
  ``,
];
writeFileSync(join(outDir, "gate-report.md"), lines.join("\n"));

const totalAccepted = Object.values(counts).reduce((n, c) => n + c.accepted, 0);
const totalRejected = Object.values(counts).reduce((n, c) => n + c.rejected, 0);
console.log(`[check-extractions] ${extractions.size} row(s): ${totalAccepted} field(s) accepted, ${totalRejected} rejected.`);
console.log(`[check-extractions] wrote ${join(outDir, "checked.json")} and gate-report.md`);
