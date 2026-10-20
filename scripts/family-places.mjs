#!/usr/bin/env node
/**
 * family-places.mjs — finds real kid-friendly Edinburgh places (playgrounds,
 * soft play, city farms, pools, family cafés, ...) through Google Places Text
 * Search (New), tags them family_fit ('kids' | 'all_ages'), de-duplicates them
 * against the live `places` catalogue, and can stage the new ones into
 * `places_staging` for the usual promote-places.mjs run. Nothing is invented
 * from model knowledge: every row is a Google result inside Edinburgh.
 * See docs/plans/2026-10-20-families-lens.md. Decisions live in
 * scripts/lib/family-places.mjs (unit-tested).
 *
 * Modes:
 *   (default)         DRY RUN. Runs the Text Search queries (live Google calls,
 *                     <= 20 requests, one page each), writes
 *                     scripts/out/family-places-<date>.json and prints a review
 *                     table (NEW vs EXISTING). Reads `places`; writes nothing to
 *                     Supabase.
 *   --from-file <f>   Re-use a previous dry run's JSON: no Google calls, so the
 *                     owner can review, then stage, without paying twice.
 *   --queries "a|b"  Run only these queries (e.g. to retry one that failed), still
 *                     within the 20-request cap.
 *   --merge <file>    Fold a previous dry run's results into this one (this run
 *                     wins on a clash), so a retry of a few queries completes
 *                     an earlier run.
 *   --stage           Upsert the NEW rows into `places_staging` (approved =
 *                     false, so nothing is promoted until the owner approves).
 *                     Never writes `places`. Needs supabase/add_family_fit.sql.
 *
 * EXISTING matches are not re-added. The file lists them as "already present ->
 * would tag family_fit X" so scripts/tag-family.mjs (or a manual update) can tag
 * them.
 *
 * Usage:
 *   node --env-file=.env.local scripts/family-places.mjs
 *   node --env-file=.env.local scripts/family-places.mjs --from-file scripts/out/family-places-2026-10-20.json
 *   node --env-file=.env.local scripts/family-places.mjs --from-file <file> --stage
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (server-only),
 * and GOOGLE_PLACES_API_KEY for live search.
 *
 * Google terms: the dry-run JSON holds Google-owned facts (rating, website,
 * phone, ...) which may only be stored 30 days; the staged row deliberately
 * leaves those out (see buildStagingRow). Stage within a day or two.
 */

import fs from "node:fs";
import path from "node:path";
import {
  BBOX,
  MAX_REQUESTS,
  QUERIES,
  SEARCH_MASK,
  buildEntry,
  buildSearchBody,
  buildStagingRow,
  estimateCost,
  evaluateCandidate,
  findExisting,
  findRunDuplicate,
  isMissingColumnError,
  summarise,
} from "./lib/family-places.mjs";

const TAG = "[family-places]";
const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const MIN_CALL_INTERVAL_MS = 250;
const DAY_MS = 86_400_000;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  if (i === -1) return null;
  if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
    console.error(`${TAG} ${n} needs a value.`);
    process.exit(1);
  }
  return argv[i + 1];
};

if (flag("--help") || flag("-h")) {
  console.log(`Usage: node --env-file=.env.local scripts/family-places.mjs [options]

Finds kid-friendly Edinburgh places via Google Places Text Search (New), tags family_fit,
and de-dupes against the live places table. Default is a DRY RUN.

  --from-file <json>   Re-use a previous dry run (no Google calls).
  --queries "a|b"      Run only these queries (retry a failed one).
  --merge <json>       Fold a previous dry run's results into this run (this run wins).
  --stage              Upsert the NEW rows into places_staging (approved=false). Never writes places.
  --help               This text.

Requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY; GOOGLE_PLACES_API_KEY for live search.
`);
  process.exit(0);
}

const fromFile = opt("--from-file");
const queriesArg = opt("--queries");
const mergeFile = opt("--merge");
const STAGE = flag("--stage");
for (const a of argv) {
  if (!["--from-file", "--stage", "--queries", "--merge", "--help", "-h"].includes(a) && a.startsWith("--")) {
    console.error(`${TAG} unknown argument ${a}. Try --help.`);
    process.exit(1);
  }
}

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const googleKey = process.env.GOOGLE_PLACES_API_KEY ?? "";
if (!supabaseUrl || !serviceRoleKey) {
  console.error(`${TAG} Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Run with: node --env-file=.env.local scripts/family-places.mjs`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Supabase REST (direct, like the other scripts — no supabase-js / WebSocket)
// ---------------------------------------------------------------------------

const sbHeaders = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" };

async function rest(p, options = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${p}`, { ...options, headers: { ...sbHeaders, ...(options.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${options.method ?? "GET"} ${p.split("?")[0]} -> ${res.status}: ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

async function fetchAllPages(p) {
  const PAGE = 1000;
  const rows = [];
  const sep = p.includes("?") ? "&" : "?";
  for (let offset = 0; ; offset += PAGE) {
    const page = await rest(`${p}${sep}limit=${PAGE}&offset=${offset}`);
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

// Same Edinburgh set as enrich-places-google.mjs; select * so family_fit comes back when the column exists.
const loadEdinburghPlaces = () =>
  fetchAllPages("places?select=*&order=id.asc&or=(city.ilike.*edinburgh*,destination.ilike.*edinburgh*,address.ilike.*edinburgh*)");

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;
let lastCallAt = 0;

async function searchText(query) {
  const wait = lastCallAt + MIN_CALL_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  requests += 1; // counted per HTTP request; no retries, so the cap is a hard cap
  try {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": googleKey, "X-Goog-FieldMask": SEARCH_MASK },
      body: JSON.stringify(buildSearchBody(query)),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) return { ok: false, error: `${res.status} ${json?.error?.message ?? text.slice(0, 200)}`, places: [] };
    return { ok: true, places: json?.places ?? [] };
  } catch (err) {
    return { ok: false, error: err.message, places: [] };
  }
}

// ---------------------------------------------------------------------------
// Dry run: search, filter, classify, dedupe
// ---------------------------------------------------------------------------

async function runSearch(existingRows, queries) {
  if (!googleKey) {
    console.error(`${TAG} Missing GOOGLE_PLACES_API_KEY (or use --from-file to re-use a dry run).`);
    process.exit(1);
  }
  if (queries.length > MAX_REQUESTS) throw new Error(`${queries.length} queries exceeds the ${MAX_REQUESTS}-request cap`);
  console.log(
    `${TAG} ${queries.length} Text Search requests (1 page of <= 20 each, cap ${MAX_REQUESTS}), ` +
      `Enterprise + Atmosphere field mask ~ USD 40/1000 -> estimated cost USD ${estimateCost(queries.length).toFixed(2)} ` +
      `(worst case at the cap: USD ${estimateCost(MAX_REQUESTS).toFixed(2)}).`
  );

  // Pass 1: collect every raw result, remembering which queries found it.
  const raw = new Map(); // google id -> { place, foundBy: [] }
  const perQuery = [];
  const errors = [];
  for (const q of queries) {
    if (requests >= MAX_REQUESTS) break;
    const r = await searchText(q);
    if (!r.ok) {
      errors.push({ query: q, error: r.error });
      console.error(`${TAG} query "${q}" FAILED: ${r.error}`);
      perQuery.push({ query: q, results: 0, error: r.error });
      continue;
    }
    perQuery.push({ query: q, results: r.places.length });
    console.log(`${TAG} "${q}" -> ${r.places.length} results`);
    for (const p of r.places) {
      if (!p?.id) continue;
      const hit = raw.get(p.id);
      if (hit) {
        if (!hit.foundBy.includes(q)) hit.foundBy.push(q);
      } else {
        raw.set(p.id, { place: p, foundBy: [q] });
      }
    }
  }

  // Pass 2: filter + classify + dedupe.
  const entries = [];
  const dropped = [];
  const accepted = [];
  for (const { place, foundBy } of raw.values()) {
    const verdict = evaluateCandidate(place, foundBy);
    if (!verdict.keep) {
      dropped.push({
        name: place.displayName?.text ?? null,
        google_place_id: place.id,
        reason: verdict.reason,
        rating_count: place.userRatingCount ?? null,
        google_types: place.types ?? [],
        found_by: foundBy,
      });
      continue;
    }
    if (findRunDuplicate(place, accepted)) {
      dropped.push({ name: place.displayName?.text ?? null, google_place_id: place.id, reason: "duplicate within run", found_by: foundBy });
      continue;
    }
    accepted.push(place);
    entries.push(buildEntry(place, verdict, foundBy, findExisting(place, existingRows)));
  }
  entries.sort((a, b) => (a.status === b.status ? 0 : a.status === "new" ? -1 : 1) || a.family_fit.localeCompare(b.family_fit) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  return {
    generated: new Date().toISOString(),
    bbox: BBOX,
    queries,
    requests,
    estimated_cost_usd: estimateCost(requests),
    per_query: perQuery,
    errors,
    raw_results: raw.size,
    counts: summarise(entries),
    dropped_counts: dropped.reduce((o, d) => ({ ...o, [d.reason]: (o[d.reason] ?? 0) + 1 }), {}),
    results: entries,
    dropped,
  };
}

/** Fold an earlier dry run into this one: its results/dropped are kept unless this run saw the same place. */
function mergeRuns(fresh, old) {
  const seen = new Set([...fresh.results, ...fresh.dropped].map((e) => e.google_place_id));
  const results = [...fresh.results, ...old.results.filter((e) => !seen.has(e.google_place_id))];
  const dropped = [...fresh.dropped, ...(old.dropped ?? []).filter((e) => !seen.has(e.google_place_id))];
  const oldQueries = old.queries ?? [];
  // A query that failed before and succeeded now is no longer an error.
  const doneNow = new Set(fresh.per_query.filter((q) => !q.error).map((q) => q.query));
  const perQuery = [...fresh.per_query, ...(old.per_query ?? []).filter((q) => !doneNow.has(q.query))];
  results.sort((a, b) => (a.status === b.status ? 0 : a.status === "new" ? -1 : 1) || a.family_fit.localeCompare(b.family_fit) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return {
    ...fresh,
    queries: [...new Set([...oldQueries, ...fresh.queries])],
    requests: (old.requests ?? 0) + fresh.requests,
    estimated_cost_usd: Math.round(((old.estimated_cost_usd ?? 0) + fresh.estimated_cost_usd) * 100) / 100,
    per_query: perQuery,
    errors: perQuery.filter((q) => q.error).map((q) => ({ query: q.query, error: q.error })),
    raw_results: results.length + dropped.length,
    counts: summarise(results),
    dropped_counts: dropped.reduce((o, d) => ({ ...o, [d.reason]: (o[d.reason] ?? 0) + 1 }), {}),
    results,
    dropped,
    merged_from: { generated: old.generated, requests: old.requests ?? null },
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function printTable(data) {
  const rows = data.results;
  const head = ["", "name", "category", "fit", "rating", "address", "google types", "status"];
  const body = rows.map((e) => [
    e.status === "new" ? "+" : "=",
    clip(e.name, 38),
    e.category,
    e.family_fit,
    e.rating_count == null ? "-" : `${e.rating ?? "-"}/${e.rating_count}`,
    clip(e.address?.replace(/, (?:Edinburgh|UK)\b/g, "").replace(/,? ?UK$/, ""), 44),
    clip((e.google_types ?? []).filter((t) => !["point_of_interest", "establishment"].includes(t)).slice(0, 3).join(","), 32),
    e.status === "new" ? "NEW" : `EXISTING (${e.existing?.matched_by}) -> would tag ${e.family_fit}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log("\n" + line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of body) console.log(line(r));
}

function printSummary(data) {
  const c = data.counts;
  console.log(
    `\n${TAG} ${data.requests} Google request(s), est. USD ${data.estimated_cost_usd?.toFixed?.(2) ?? data.estimated_cost_usd}. ` +
      `${data.raw_results} unique results -> ${c.total} kept (${c.new} NEW, ${c.existing} EXISTING), ${data.dropped?.length ?? 0} dropped.`
  );
  console.log(`${TAG} NEW by family_fit: ${JSON.stringify(c.new_by_family_fit)}`);
  console.log(`${TAG} NEW by category:   ${JSON.stringify(c.new_by_category)}`);
  console.log(`${TAG} Dropped by reason: ${JSON.stringify(data.dropped_counts)}`);
  const existing = data.results.filter((e) => e.status === "existing");
  if (existing.length) {
    console.log(`\n${TAG} Already present -> would tag family_fit (tag with scripts/tag-family.mjs or by hand):`);
    for (const e of existing) {
      const cur = e.existing?.family_fit;
      console.log(`  ${e.existing.name} (${e.existing.id}) [${e.existing.category ?? "?"}] -> ${e.family_fit}${cur ? ` (currently ${cur})` : ""}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

async function stage(data) {
  const fresh = data.results.filter((e) => e.status === "new");
  if (fresh.length === 0) {
    console.log(`${TAG} nothing NEW to stage.`);
    return;
  }
  const age = (Date.now() - new Date(data.generated).getTime()) / DAY_MS;
  if (age > 7) console.warn(`${TAG} WARNING: results are ${age.toFixed(0)} days old (Google data may only be kept 30 days; rows may be stale or closed). Consider a fresh dry run.`);

  // Fail early, with the right instruction, when the column is not there.
  try {
    await rest("places_staging?select=family_fit&limit=1");
  } catch (err) {
    if (isMissingColumnError(err.status, err.body)) {
      console.error(`${TAG} places_staging has no family_fit column — run supabase/add_family_fit.sql first.`);
      process.exit(1);
    }
    throw err;
  }

  const batchId = `family-places-${localDate(new Date(data.generated))}`;
  const taken = new Set();
  const now = new Date();
  const rows = fresh.map((e) => buildStagingRow(e, { batchId, now, taken }));
  try {
    await rest("places_staging?on_conflict=batch_id,dedupe_key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
  } catch (err) {
    if (isMissingColumnError(err.status, err.body)) {
      console.error(`${TAG} places_staging has no family_fit column — run supabase/add_family_fit.sql first.`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`${TAG} staged ${rows.length} row(s) into places_staging, batch_id=${batchId} (approved=false). \`places\` was NOT touched.`);
  console.log(`
Next, in the Supabase SQL editor, approve what you want to promote (drop rows you do not want first, or exclude by name):

  update places_staging set approved = true, extraction_status = 'approved'
   where batch_id = '${batchId}' and extraction_status <> 'promoted';

Then (dry run first, then without --dry-run):

  node --env-file=.env.local scripts/promote-places.mjs --country-code GB --source seed-family-places --destination-city Edinburgh --dry-run
  node --env-file=.env.local scripts/promote-places.mjs --country-code GB --source seed-family-places --destination-city Edinburgh

Afterwards fill hours/ratings/phone for the new rows with scripts/enrich-places-google.mjs.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let data;
  if (fromFile) {
    data = JSON.parse(fs.readFileSync(fromFile, "utf8"));
    if (!Array.isArray(data.results)) throw new Error(`${fromFile}: no results array`);
    console.log(`${TAG} using ${data.results.length} saved results from ${fromFile} (generated ${data.generated}); no Google calls.`);
  } else {
    const existingRows = await loadEdinburghPlaces();
    console.log(`${TAG} loaded ${existingRows.length} existing Edinburgh places`);
    const queries = queriesArg ? queriesArg.split("|").map((q) => q.trim()).filter(Boolean) : QUERIES;
    data = await runSearch(existingRows, queries);
    if (mergeFile) {
      data = mergeRuns(data, JSON.parse(fs.readFileSync(mergeFile, "utf8")));
      console.log(`${TAG} merged with ${mergeFile}: ${data.requests} Google requests in total, est. USD ${data.estimated_cost_usd.toFixed(2)}.`);
    }
    const out = path.join("scripts", "out", `family-places-${localDate()}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
    console.log(`${TAG} wrote ${out}`);
    console.log(`${TAG} to stage later without re-paying: node --env-file=.env.local scripts/family-places.mjs --from-file ${out} --stage`);
  }
  printTable(data);
  printSummary(data);
  if (STAGE) await stage(data);
  else console.log(`\n${TAG} DRY RUN: nothing written to Supabase. Pass --stage (with --from-file <this json>) to stage the NEW rows.`);
}

main().catch((err) => {
  console.error(`${TAG} fatal:`, err);
  process.exit(1);
});
