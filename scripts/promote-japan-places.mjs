#!/usr/bin/env node
/**
 * promote-japan-places.mjs — promotes approved `places_staging` rows into
 * the shared `places` table, records per-field provenance in
 * `place_sources`, and marks the staging row as promoted.
 *
 * Despite the filename (kept for backward compat with existing usage/docs),
 * this script is country-agnostic: it promotes whatever staging rows match
 * `--source` (default `seed-japan-pipeline`), and derives each row's
 * `destination` suffix from `staging.country` via COUNTRY_DESTINATION_LABEL
 * (falling back to the raw `staging.country` value for an unmapped code, or
 * `--destination-suffix` to force one suffix for the whole run).
 *
 * Idempotent: only selects staging rows that are approved and not yet
 * promoted, so re-running after a partial failure or a new batch is safe.
 *
 * Uses the Supabase REST API directly (not @supabase/supabase-js) to avoid
 * that client's mandatory Realtime/WebSocket init, which isn't available in
 * plain Node 20.
 *
 * Usage:
 *   node --env-file=.env.local scripts/promote-japan-places.mjs
 *   node --env-file=.env.local scripts/promote-japan-places.mjs --source seed-scotland-pipeline
 *   node --env-file=.env.local scripts/promote-japan-places.mjs --source seed-scotland-pipeline --destination-suffix Scotland
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (same
 * vars the app itself uses, see lib/supabase.ts) — the anon role already has
 * write access to `places`, `places_staging`, and `place_sources`.
 */

function parseArg(name) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1) return process.argv[idx + 1];
  const prefixed = process.argv.find((a) => a.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : undefined;
}

// Which places_staging rows to promote — filtered by `places_staging.country`
// (that table has no `source` column; `source` only exists on the
// destination `places` table, see PLACES_COLUMNS/buildPlaceRow below).
const DEFAULT_COUNTRY_CODE = "JP";
const COUNTRY_CODE = (parseArg("country-code") ?? DEFAULT_COUNTRY_CODE).toUpperCase();

const DEFAULT_SOURCE = "seed-japan-pipeline";
const SOURCE = parseArg("source") ?? DEFAULT_SOURCE;
const DESTINATION_SUFFIX_OVERRIDE = parseArg("destination-suffix");

// `places.country` -> the human-readable label used in the `destination`
// string (e.g. "Edinburgh, Scotland"), matching how the app's own
// destination strings read (see lib/db/trips.ts's "Tokyo, Japan" demo trip).
// Add an entry here for each new country's pipeline.
const COUNTRY_DESTINATION_LABEL = {
  JP: "Japan",
  GB: "Scotland",
};

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "[promote] Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
      "Run with: node --env-file=.env.local scripts/promote-japan-places.mjs"
  );
  process.exit(1);
}

const headers = {
  apikey: supabaseAnonKey,
  Authorization: `Bearer ${supabaseAnonKey}`,
  "Content-Type": "application/json",
};

async function rest(path, options = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${options.method ?? "GET"} ${path} → ${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const PLACES_COLUMNS = [
  "name",
  "category",
  "description",
  "rating",
  "image_url",
  "tips",
  "hours",
  "hours_status",
  "station",
  "badges",
  "google_place_id",
  "lat",
  "lng",
  "address",
  "price_level",
  "city",
  "prefecture",
  "country",
  "last_verified_at",
];

function buildPlaceRow(staging) {
  const row = { source: SOURCE, fetched_at: new Date().toISOString() };
  for (const col of PLACES_COLUMNS) {
    if (staging[col] !== undefined && staging[col] !== null) row[col] = staging[col];
  }
  // Extraction sometimes writes the literal string "unknown" into `hours`
  // instead of leaving it null (the intended signal is hours_status
  // 'unknown', not text that renders verbatim as "unknown" in the UI).
  if (row.hours_status !== "known" && row.hours === "unknown") {
    row.hours = null;
  }
  const cityOrPrefecture = staging.city || staging.prefecture;
  const destinationSuffix =
    DESTINATION_SUFFIX_OVERRIDE ?? COUNTRY_DESTINATION_LABEL[staging.country] ?? staging.country;
  row.destination =
    cityOrPrefecture && destinationSuffix ? `${cityOrPrefecture}, ${destinationSuffix}` : null;
  return row;
}

async function fetchAllApprovedStaging() {
  // PostgREST caps a single response at 1000 rows by default — without
  // pagination here, any batch bigger than that silently loses rows every
  // run (surfaced when the Scotland batch's 3371 approved rows only
  // promoted 1000 per invocation, requiring several manual re-runs).
  const PAGE_SIZE = 1000;
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await rest(
      `places_staging?country=eq.${encodeURIComponent(COUNTRY_CODE)}&approved=eq.true&extraction_status=neq.promoted&select=*&limit=${PAGE_SIZE}&offset=${offset}`
    );
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function main() {
  const stagingRows = await fetchAllApprovedStaging();

  if (!stagingRows || stagingRows.length === 0) {
    console.log(`[promote] nothing to promote — no approved, un-promoted staging rows for country=${COUNTRY_CODE}.`);
    return;
  }

  console.log(`[promote] country=${COUNTRY_CODE} source=${SOURCE}: found ${stagingRows.length} staging row(s) to promote.`);

  const results = [];
  let failed = 0;

  for (const staging of stagingRows) {
    if (!staging.name || !(staging.city || staging.prefecture)) {
      console.error(
        `[promote] SKIP ${staging.id} (${staging.dedupe_key}): missing name or city/prefecture`
      );
      failed += 1;
      continue;
    }

    const placeRow = buildPlaceRow(staging);
    let inserted;
    try {
      const rows = await rest("places", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(placeRow),
      });
      inserted = rows?.[0];
    } catch (err) {
      console.error(`[promote] FAILED inserting "${staging.name}" (${staging.dedupe_key}): ${err.message}`);
      failed += 1;
      continue;
    }

    if (!inserted?.id) {
      console.error(`[promote] FAILED inserting "${staging.name}": no id returned`);
      failed += 1;
      continue;
    }

    const placeId = inserted.id;

    const fieldSources =
      staging.field_sources && typeof staging.field_sources === "object"
        ? Object.entries(staging.field_sources)
        : [];
    const sourceRows = fieldSources
      .filter(([, url]) => typeof url === "string" && url.length > 0)
      .map(([fieldName, url]) => ({
        place_id: placeId,
        staging_id: staging.id,
        field_name: fieldName,
        source_url: url,
        extractor: staging.extraction_model ?? null,
      }));

    if (sourceRows.length > 0) {
      try {
        await rest("place_sources", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(sourceRows),
        });
      } catch (err) {
        console.error(`[promote] WARN: place_sources insert failed for "${staging.name}": ${err.message}`);
      }
    }

    try {
      await rest(`places_staging?id=eq.${staging.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ place_id: placeId, extraction_status: "promoted" }),
      });
    } catch (err) {
      console.error(
        `[promote] WARN: promoted "${staging.name}" to places (${placeId}) but failed to ` +
          `update places_staging: ${err.message}`
      );
    }

    results.push({ name: staging.name, place_id: placeId });
    console.log(`[promote] OK  ${staging.name} → ${placeId}`);
  }

  console.log(`\n[promote] done. promoted=${results.length} failed=${failed}`);
  if (results.length > 0) console.table(results);
}

main().catch((err) => {
  console.error("[promote] fatal:", err);
  process.exit(1);
});
