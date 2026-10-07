#!/usr/bin/env node
/**
 * enrich-places-google.mjs — fills in Edinburgh `places` from Google Places
 * (New): resolves missing google_place_id values, then reads Place Details for
 * every row and proposes what to write. See
 * docs/plans/2026-10-07-data-enrichment.md §2.
 *
 * What gets written (decisions live in scripts/lib/google-place-map.mjs,
 * unit-tested):
 *   - FILLS, only where the row is blank, kept forever: opening_hours, hours,
 *     address, lat, lng, price_level, google_place_id.
 *   - GOOGLE-OWNED facts, always written and refreshed: rating,
 *     google_rating_count, price_range, website, phone, google_maps_uri,
 *     business_status, google_summary (+ disclosure), google_fetched_at.
 *     Google's terms allow storing these for at most 30 days, so
 *     --refresh --apply runs monthly (.github/workflows/monthly-places-refresh.yml)
 *     and clears Google-owned columns that are >30 days old and could not be
 *     refreshed. The place ID is exempt.
 *   - CHANGES (Google disagrees with an existing address/lat/lng/price_level/
 *     hours) are only listed in the report; apply reviewed ones with
 *     --apply-changes.
 *   - Rows whose id could not be matched safely are AMBIGUOUS (or NOT_FOUND),
 *     listed in the report and never written. Rows whose Google location is
 *     >250 m from the stored one ('moved') are held for review, not written.
 *
 * DRY RUN is the DEFAULT: Google is called, but nothing is written to
 * Supabase. Output goes to scraper/out/enrich-YYYY-MM-DD/:
 *   places-proposals.json   per row: resolved id, fills, google, flags, changes
 *   places-report.md        counts, AMBIGUOUS list, flags, changes, sample fills
 * Every write also records the previous values of the touched columns in
 * places-rollback-<timestamp>.json (--rollback <file> restores them). This
 * script never deletes a row.
 *
 * Usage:
 *   node --env-file=.env.local scripts/enrich-places-google.mjs [--limit 20] [--apply]
 *
 * Options:
 *   --apply                  Write fills + Google-owned fields (after fetching).
 *   --from-proposals <file>  With --apply: use a saved places-proposals.json
 *                            instead of calling Google again (no API spend).
 *   --apply-changes <file>   Apply reviewed changes: JSON array of
 *                            { id, field, value }. No Google calls.
 *   --rollback <file>        Restore previous values from a rollback file.
 *   --refresh                Details only, for rows with a google_place_id whose
 *                            google_fetched_at is null or older than 25 days;
 *                            writes Google-owned fields only (+ expiry clearing).
 *   --max-calls N            Cap on Google calls (default 1200); the rest are
 *                            reported as skipped.
 *   --limit N                Process only the first N target rows.
 *   --only id,id             Process only these place ids.
 *   --use-matches <file>     Reviewed picks for AMBIGUOUS rows ([{ id, google_place_id, confidence }]; "high" only).
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server-only) and,
 * for anything that calls Google, GOOGLE_PLACES_API_KEY.
 */

import fs from "node:fs";
import path from "node:path";
import {
  EDINBURGH_CENTRE,
  GOOGLE_OWNED_COLUMNS,
  acceptMatch,
  buildPlacePatch,
} from "./lib/google-place-map.mjs";

const TAG = "[enrich-places-google]";
const DAY_MS = 86_400_000;
const REFRESH_AFTER_DAYS = 25;
const EXPIRE_AFTER_DAYS = 30;
const DEFAULT_MAX_CALLS = 1200;
const MIN_CALL_INTERVAL_MS = 200; // ~5 requests/second
const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const DETAILS_URL = "https://places.googleapis.com/v1/places";
const SEARCH_MASK = "places.id,places.displayName,places.formattedAddress,places.location";
const DETAILS_MASK =
  "id,displayName,formattedAddress,location,regularOpeningHours,rating,userRatingCount,priceLevel,priceRange," +
  "websiteUri,nationalPhoneNumber,businessStatus,googleMapsUri,editorialSummary,reviewSummary,generativeSummary";
// Columns --apply-changes may touch (the fields `changes` can list).
const CHANGEABLE_FIELDS = new Set(["address", "lat", "lng", "price_level", "hours", "opening_hours"]);

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    apply: false, refresh: false, help: false, maxCalls: DEFAULT_MAX_CALLS, limit: null,
    only: null, applyChanges: null, rollback: null, fromProposals: null, useMatches: null,
  };
  const value = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--refresh") out.refresh = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--max-calls") out.maxCalls = Number(value(i++, a));
    else if (a === "--limit") out.limit = Number(value(i++, a));
    else if (a === "--only") out.only = new Set(value(i++, a).split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--apply-changes") out.applyChanges = value(i++, a);
    else if (a === "--rollback") out.rollback = value(i++, a);
    else if (a === "--from-proposals") out.fromProposals = value(i++, a);
    else if (a === "--use-matches") out.useMatches = value(i++, a);
    else throw new Error(`unknown argument ${a}`);
  }
  for (const [k, v] of [["--max-calls", out.maxCalls], ["--limit", out.limit]]) {
    if (v != null && (!Number.isInteger(v) || v < 0)) throw new Error(`${k} must be a non-negative integer`);
  }
  return out;
}

let args;
/** --use-matches: our place id → Google place id, high-confidence reviewer picks only. */
let reviewedMatches = null;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`${TAG} ${err.message}. Try --help.`);
  process.exit(1);
}

if (args.useMatches) {
  const picks = JSON.parse(fs.readFileSync(args.useMatches, "utf8"));
  reviewedMatches = new Map(
    picks.filter((p) => p.google_place_id && p.confidence === "high").map((p) => [p.id, p.google_place_id])
  );
}

if (args.help) {
  console.log(`Usage: node --env-file=.env.local scripts/enrich-places-google.mjs [options]

Resolves Google place ids and reads Place Details for Edinburgh places.
Default is a DRY RUN (calls Google, writes nothing to Supabase).

  --apply                  Write fills + Google-owned fields.
  --from-proposals <file>  With --apply: reuse a saved places-proposals.json (no Google calls).
  --apply-changes <file>   Apply reviewed changes ([{ id, field, value }]).
  --rollback <file>        Restore previous values from a rollback file.
  --refresh                Details only, rows last fetched >${REFRESH_AFTER_DAYS} days ago; Google-owned fields only.
  --max-calls N            Cap on Google calls (default ${DEFAULT_MAX_CALLS}).
  --limit N                Process only the first N target rows.
  --only id,id             Process only these place ids.
  --use-matches <file>     Reviewed picks for AMBIGUOUS rows ([{ id, google_place_id, confidence }]; "high" only).

Requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_PLACES_API_KEY.
`);
  process.exit(0);
}

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const googleKey = process.env.GOOGLE_PLACES_API_KEY ?? "";

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    `${TAG} Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. ` +
      "Run with: node --env-file=.env.local scripts/enrich-places-google.mjs"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Supabase REST (direct, not supabase-js — same reasoning as the other scripts)
// ---------------------------------------------------------------------------

const sbHeaders = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

async function rest(p, options = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${p}`, {
    ...options,
    headers: { ...sbHeaders, ...(options.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${p} -> ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// PostgREST caps a response at 1000 rows: page with limit/offset.
async function fetchAllPages(p) {
  const PAGE_SIZE = 1000;
  const rows = [];
  const sep = p.includes("?") ? "&" : "?";
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await rest(`${p}${sep}limit=${PAGE_SIZE}&offset=${offset}`);
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

const loadEdinburghPlaces = () =>
  fetchAllPages("places?select=*&order=id.asc&or=(city.ilike.*edinburgh*,destination.ilike.*edinburgh*)");

async function patchPlace(id, patch) {
  await rest(`places?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
}

// ---------------------------------------------------------------------------
// Google (network only; decisions are in lib/google-place-map.mjs)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastCallAt = 0;
let googleCalls = 0;

async function throttle() {
  const wait = lastCallAt + MIN_CALL_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

// fetch with throttle; retries 429/5xx twice with backoff. Returns { ok, status, json, error }.
async function googleFetch(url, init) {
  googleCalls += 1;
  let last = { ok: false, status: 0, json: null, error: "no attempt" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(1000 * 3 ** (attempt - 1));
    await throttle();
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON error body */
      }
      last = { ok: res.ok, status: res.status, json, error: res.ok ? null : (json?.error?.message ?? text.slice(0, 200)) };
      if (res.ok || (res.status !== 429 && res.status < 500)) return last;
    } catch (err) {
      last = { ok: false, status: 0, json: null, error: err.message };
    }
  }
  return last;
}

function textSearch(row) {
  return googleFetch(SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": googleKey, "X-Goog-FieldMask": SEARCH_MASK },
    body: JSON.stringify({
      textQuery: `${row.name}, ${row.address || "Edinburgh"}`,
      maxResultCount: 3,
      locationBias: {
        circle: { center: { latitude: EDINBURGH_CENTRE.lat, longitude: EDINBURGH_CENTRE.lng }, radius: 10000 },
      },
      regionCode: "GB",
      languageCode: "en",
    }),
  });
}

function placeDetails(placeId) {
  return googleFetch(`${DETAILS_URL}/${encodeURIComponent(placeId)}?languageCode=en&regionCode=GB`, {
    headers: { "X-Goog-Api-Key": googleKey, "X-Goog-FieldMask": DETAILS_MASK },
  });
}

// ---------------------------------------------------------------------------
// Output + rollback
// ---------------------------------------------------------------------------

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const outDir = path.join("scraper", "out", `enrich-${localDate()}`);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const rollbackPath = path.join(outDir, `places-rollback-${stamp}.json`);

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** Patch a row, first recording the previous values of every column being touched. */
function makeWriter(rowsById, mode) {
  const entries = [];
  const flush = () => writeJson(rollbackPath, { created: new Date().toISOString(), mode, entries });
  return {
    async write(id, patch) {
      const row = rowsById.get(id);
      if (!row) throw new Error(`row ${id} not found in the current Edinburgh set`);
      const previous = {};
      for (const k of Object.keys(patch)) previous[k] = row[k] ?? null;
      entries.push({ id, previous });
      flush(); // before the PATCH, so a crash mid-write still leaves a usable rollback
      await patchPlace(id, patch);
    },
    count: () => entries.length,
    flush,
  };
}

async function runRollback(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = [...(data.entries ?? [])].reverse(); // undo newest first
  let ok = 0;
  let failed = 0;
  for (const { id, previous } of entries) {
    try {
      await patchPlace(id, previous);
      ok += 1;
    } catch (err) {
      failed += 1;
      console.error(`${TAG} rollback FAILED ${id}: ${err.message}`);
    }
  }
  console.log(`${TAG} rollback done: restored=${ok} failed=${failed} (from ${file})`);
  if (failed) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// --apply-changes
// ---------------------------------------------------------------------------

async function runApplyChanges(file) {
  const changes = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(changes)) throw new Error("--apply-changes file must be a JSON array of { id, field, value }");
  const byId = new Map();
  for (const c of changes) {
    if (!c?.id || !CHANGEABLE_FIELDS.has(c.field)) {
      throw new Error(`bad change ${JSON.stringify(c)}; field must be one of ${[...CHANGEABLE_FIELDS].join(", ")}`);
    }
    byId.set(c.id, { ...(byId.get(c.id) ?? {}), [c.field]: c.value });
  }
  const rows = await loadEdinburghPlaces();
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const writer = makeWriter(rowsById, "apply-changes");
  let ok = 0;
  let failed = 0;
  for (const [id, patch] of byId) {
    try {
      await writer.write(id, patch);
      ok += 1;
      console.log(`${TAG} changed ${rowsById.get(id)?.name ?? id}: ${Object.keys(patch).join(", ")}`);
    } catch (err) {
      failed += 1;
      console.error(`${TAG} FAILED ${id}: ${err.message}`);
    }
  }
  writer.flush();
  console.log(`${TAG} apply-changes done: ok=${ok} failed=${failed}. Rollback: ${rollbackPath}`);
  if (failed) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Select + fetch
// ---------------------------------------------------------------------------

const ageDays = (iso, now) => (iso ? (now - new Date(iso).getTime()) / DAY_MS : Infinity);

function selectTargets(rows, now) {
  let targets = rows.filter((r) => !args.only || args.only.has(r.id));
  // Reviewed matches: only those rows, and only while they still have no id.
  if (reviewedMatches) targets = targets.filter((r) => !r.google_place_id && reviewedMatches.has(r.id));
  const skippedFresh = [];
  if (args.refresh) {
    targets = targets.filter((r) => r.google_place_id && ageDays(r.google_fetched_at, now) > REFRESH_AFTER_DAYS);
  } else {
    // Re-running should not re-buy details that are still fresh.
    targets = targets.filter((r) => {
      const fresh = r.google_place_id && r.google_fetched_at && ageDays(r.google_fetched_at, now) <= REFRESH_AFTER_DAYS;
      if (fresh) skippedFresh.push(r);
      return !fresh;
    });
  }
  if (args.limit != null) targets = targets.slice(0, args.limit);
  return { targets, skippedFresh };
}

async function fetchProposals(targets, now) {
  const proposals = [];
  const stats = { ambiguous: 0, notFound: 0, searchFailed: 0, detailsFailed: 0, skippedCap: 0, searchCalls: 0, detailsCalls: 0 };
  const underCap = () => googleCalls < args.maxCalls;
  let n = 0;

  for (const row of targets) {
    n += 1;
    if (n % 50 === 0) console.log(`${TAG}   ... ${n}/${targets.length} rows, ${googleCalls} Google calls`);
    const proposal = {
      id: row.id,
      name: row.name,
      resolved: { google_place_id: row.google_place_id ?? null, how: row.google_place_id ? "existing" : null },
      status: "pending",
      fills: {},
      google: {},
      flags: [],
      changes: [],
    };
    proposals.push(proposal);

    let placeId = row.google_place_id;
    if (!placeId && reviewedMatches?.has(row.id)) {
      // Picked by a reviewer from this row's AMBIGUOUS candidates; Details and the 'moved' check still run.
      placeId = reviewedMatches.get(row.id);
      proposal.resolved = { google_place_id: placeId, how: "reviewed" };
    }
    if (!placeId) {
      if (!underCap()) {
        proposal.status = "skipped_cap";
        stats.skippedCap += 1;
        continue;
      }
      stats.searchCalls += 1;
      const found = await textSearch(row);
      if (!found.ok) {
        proposal.status = "search_failed";
        proposal.error = `${found.status} ${found.error}`;
        stats.searchFailed += 1;
        continue;
      }
      const candidates = found.json?.places ?? [];
      const checked = candidates.map((c) => ({ c, verdict: acceptMatch(row, c) }));
      const accepted = checked.find((x) => x.verdict.ok);
      if (!accepted) {
        proposal.status = candidates.length === 0 ? "not_found" : "ambiguous";
        proposal.candidates = checked.map(({ c, verdict }) => ({
          id: c.id,
          name: c.displayName?.text ?? null,
          address: c.formattedAddress ?? null,
          distance_m: verdict.distance,
          reason: verdict.reason,
        }));
        if (candidates.length === 0) stats.notFound += 1;
        else stats.ambiguous += 1;
        continue;
      }
      placeId = accepted.c.id;
      proposal.resolved = { google_place_id: placeId, how: "text_search", match: accepted.verdict.reason };
    }

    if (!underCap()) {
      proposal.status = "skipped_cap";
      stats.skippedCap += 1;
      continue;
    }
    stats.detailsCalls += 1;
    const got = await placeDetails(placeId);
    if (!got.ok) {
      proposal.status = "details_failed";
      proposal.error = `${got.status} ${got.error}`;
      stats.detailsFailed += 1;
      continue;
    }
    const patch = buildPlacePatch(row, got.json, now);
    proposal.status = "ok";
    // --refresh writes Google-owned fields only; fills belong to the first pass.
    proposal.fills = args.refresh ? {} : patch.fills;
    proposal.google = patch.google;
    proposal.flags = patch.flags;
    proposal.changes = patch.changes;
  }
  return { proposals, stats };
}

// Expiry compliance: Google-owned columns older than 30 days that were not
// refreshed this run are cleared (place id and fills are kept).
function expiryClears(rows, proposals, now) {
  // A 'moved' row is read but held (not written), so its stored Google data still ages out.
  const refreshed = new Set(proposals.filter((p) => p.status === "ok" && !p.flags.includes("moved")).map((p) => p.id));
  const attempted = new Set(proposals.map((p) => p.id));
  return rows.filter(
    (r) =>
      attempted.has(r.id) &&
      !refreshed.has(r.id) &&
      r.google_fetched_at &&
      ageDays(r.google_fetched_at, now) > EXPIRE_AFTER_DAYS
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function buildReport({ proposals, stats, rows, skippedFresh, clears, now }) {
  const ok = proposals.filter((p) => p.status === "ok");
  const fillCounts = {};
  for (const p of ok) for (const k of Object.keys(p.fills)) fillCounts[k] = (fillCounts[k] ?? 0) + 1;
  const held = ok.filter((p) => p.flags.includes("moved"));
  const closed = ok.filter((p) => p.flags.includes("closed_permanently"));
  const withChanges = ok.filter((p) => p.changes.length > 0);
  const lines = [];
  lines.push(`# Places enrichment report ${localDate(now)} (${args.refresh ? "refresh" : "first pass"}, ${args.apply ? "APPLIED" : "dry run"})`, "");
  lines.push(
    "## Counts", "",
    `- Edinburgh places loaded: ${rows.length}`,
    `- Processed: ${proposals.length} (skipped as still fresh: ${skippedFresh.length})`,
    `- Google calls made: ${googleCalls} (${stats.searchCalls} Text Search, ${stats.detailsCalls} Place Details; cap ${args.maxCalls})`,
    `- Details read OK: ${ok.length}`,
    `- New ids resolved: ${proposals.filter((p) => p.resolved.how === "text_search" && p.status === "ok").length}`,
    `- AMBIGUOUS (not written): ${stats.ambiguous}`,
    `- NOT FOUND: ${stats.notFound}`,
    `- Search failed: ${stats.searchFailed}; Details failed: ${stats.detailsFailed}`,
    `- Skipped, call cap reached: ${stats.skippedCap}`,
    `- Flagged moved (held, not written): ${held.length}; closed permanently: ${closed.length}`,
    `- Rows with changes for review: ${withChanges.length}`,
    `- Google fields to clear (>${EXPIRE_AFTER_DAYS} days old, not refreshed): ${clears.length}`,
    "",
    "Fills by field: " + (Object.keys(fillCounts).length ? Object.entries(fillCounts).map(([k, v]) => `${k} ${v}`).join(", ") : "none"),
    ""
  );

  const amb = proposals.filter((p) => p.status === "ambiguous" || p.status === "not_found");
  lines.push(`## AMBIGUOUS / NOT FOUND (${amb.length}) — never written`, "");
  for (const p of amb) {
    lines.push(`- **${p.name}** (${p.id}) — ${p.status}`);
    for (const c of p.candidates ?? []) lines.push(`    - ${c.name ?? "?"} | ${c.address ?? "?"} | ${c.id} | ${c.reason}`);
  }
  lines.push("");

  lines.push(`## Flags (${held.length + closed.length})`, "");
  for (const p of held) lines.push(`- MOVED (held): ${p.name} (${p.id})`);
  for (const p of closed) lines.push(`- CLOSED_PERMANENTLY: ${p.name} (${p.id})`);
  lines.push("");

  lines.push(`## Changes for review (${withChanges.length} rows)`, "", "Apply approved ones with --apply-changes <file> ([{ id, field, value }]).", "");
  for (const p of withChanges) {
    for (const c of p.changes) lines.push(`- ${p.name} (${p.id}) ${c.field}: ${JSON.stringify(c.current)} -> ${JSON.stringify(c.google)}`);
  }
  lines.push("");

  const withFills = ok.filter((p) => Object.keys(p.fills).length > 0);
  const step = Math.max(1, Math.floor(withFills.length / 15));
  const sample = withFills.filter((_, i) => i % step === 0).slice(0, 15);
  lines.push(`## Sample fills (${sample.length} of ${withFills.length})`, "");
  for (const p of sample) {
    const brief = Object.entries(p.fills)
      .map(([k, v]) => `${k}=${k === "opening_hours" ? `${v.length} periods` : JSON.stringify(v)}`)
      .join("; ");
    lines.push(`- ${p.name} (${p.id}): ${brief}`);
  }
  lines.push("");

  if (clears.length) {
    lines.push(`## Google data to clear (${clears.length})`, "");
    for (const r of clears) lines.push(`- ${r.name} (${r.id}), fetched ${r.google_fetched_at}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function applyProposals(proposals, clears, rows) {
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const writer = makeWriter(rowsById, args.refresh ? "refresh" : "apply");
  let ok = 0;
  let held = 0;
  let failed = 0;
  let cleared = 0;
  for (const p of proposals) {
    if (p.status !== "ok") continue;
    if (p.flags.includes("moved")) {
      held += 1; // location disagrees with ours: a human decides before anything is written
      continue;
    }
    // Closed permanently: record Google's facts (business_status shows it) but fill nothing.
    const fills = p.flags.includes("closed_permanently") ? {} : p.fills;
    const patch = { ...fills, ...p.google };
    try {
      await writer.write(p.id, patch);
      ok += 1;
    } catch (err) {
      failed += 1;
      console.error(`${TAG} FAILED ${p.name} (${p.id}): ${err.message}`);
    }
  }
  for (const r of clears) {
    const patch = Object.fromEntries(GOOGLE_OWNED_COLUMNS.map((c) => [c, null]));
    try {
      await writer.write(r.id, patch);
      cleared += 1;
    } catch (err) {
      failed += 1;
      console.error(`${TAG} FAILED clearing ${r.name} (${r.id}): ${err.message}`);
    }
  }
  writer.flush();
  console.log(`${TAG} applied: written=${ok} held(moved)=${held} cleared-expired=${cleared} failed=${failed}. Rollback: ${rollbackPath}`);
  if (failed) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (args.rollback) return runRollback(args.rollback);
  if (args.applyChanges) return runApplyChanges(args.applyChanges);

  const now = new Date();
  const rows = await loadEdinburghPlaces();
  console.log(`${TAG} loaded ${rows.length} Edinburgh places`);

  let proposals;
  let stats = { ambiguous: 0, notFound: 0, searchFailed: 0, detailsFailed: 0, skippedCap: 0, searchCalls: 0, detailsCalls: 0 };
  let skippedFresh = [];

  if (args.fromProposals) {
    if (!args.apply) throw new Error("--from-proposals only makes sense with --apply");
    const saved = JSON.parse(fs.readFileSync(args.fromProposals, "utf8"));
    proposals = saved.rows ?? [];
    const age = ageDays(saved.generated, now.getTime());
    if (age > 1) console.warn(`${TAG} WARNING: proposals are ${age.toFixed(1)} days old; Google data may only be stored for ${EXPIRE_AFTER_DAYS} days.`);
    console.log(`${TAG} using ${proposals.length} saved proposals; no Google calls.`);
  } else {
    if (!googleKey) {
      console.error(`${TAG} Missing GOOGLE_PLACES_API_KEY.`);
      process.exit(1);
    }
    const sel = selectTargets(rows, now.getTime());
    skippedFresh = sel.skippedFresh;
    const needSearch = sel.targets.filter((r) => !r.google_place_id).length;
    const haveId = sel.targets.length - needSearch;
    console.log(
      `${TAG} Will make ~${needSearch} Text Search + ~${haveId + needSearch} Place Details calls (cap ${args.maxCalls})` +
        ` for ${sel.targets.length} rows (${haveId} with an id, ${needSearch} to resolve; Details count is an upper bound).`
    );
    if (sel.targets.length === 0) {
      console.log(`${TAG} nothing to do.`);
    }
    ({ proposals, stats } = await fetchProposals(sel.targets, now));
  }

  // Expiry applies in --refresh runs (a monthly job that failed to refresh a row).
  const clears = args.refresh && !args.fromProposals ? expiryClears(rows, proposals, now.getTime()) : [];

  if (!args.fromProposals) {
    writeJson(path.join(outDir, "places-proposals.json"), {
      generated: now.toISOString(),
      mode: args.refresh ? "refresh" : "first-pass",
      googleCalls,
      rows: proposals,
    });
    fs.writeFileSync(path.join(outDir, "places-report.md"), buildReport({ proposals, stats, rows, skippedFresh, clears, now }));
    console.log(`${TAG} wrote ${path.join(outDir, "places-proposals.json")} and places-report.md (${googleCalls} Google calls).`);
  }

  if (!args.apply) {
    console.log(`${TAG} DRY RUN: nothing written to Supabase. Pass --apply to write fills + Google-owned fields.`);
    return;
  }
  await applyProposals(proposals, clears, rows);
}

main().catch((err) => {
  console.error(`${TAG} fatal:`, err);
  process.exit(1);
});
