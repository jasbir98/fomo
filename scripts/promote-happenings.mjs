#!/usr/bin/env node
/**
 * promote-happenings.mjs — promotes approved `happenings_staging` rows into
 * the shared `happenings` table, records per-field provenance in
 * `happening_sources`, and marks the staging row as promoted.
 *
 * Idempotent: only selects staging rows that are `approved = true AND
 * extraction_status <> 'promoted'`, so re-running after a partial failure or
 * a new batch is safe.
 *
 * Uses the Supabase REST API directly (not @supabase/supabase-js), mirroring
 * promote-places.mjs — that client's mandatory Realtime/WebSocket init
 * throws under plain Node 20, so this repo's one-off promote scripts hit
 * PostgREST directly with plain `fetch` instead.
 *
 * ONE DELIBERATE DEVIATION from promote-places.mjs: this script uses
 * SUPABASE_SERVICE_ROLE_KEY, not the anon key. `happenings`/
 * `happenings_staging`/`happening_sources` have no anon write policy by
 * design (see supabase/archive/add_happenings.sql / supabase/archive/harden_rls.sql) —
 * unlike `places`/`places_staging`, which the anon role can write to
 * directly, promotion here needs to bypass RLS the same way
 * backfill-trip-geo.mjs does for `trips`.
 *
 * Usage:
 *   node --env-file=.env.local scripts/promote-happenings.mjs
 *   node --env-file=.env.local scripts/promote-happenings.mjs --batch-id edi-happenings-2026-09-12
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * (server-only, see lib/supabase/admin.ts — never NEXT_PUBLIC_).
 */

import { httpUrlOrNull } from "./lib/http-url.mjs";
import { EDINBURGH_PLACES_QUERY, buildPlaceIndex, matchHappening } from "./lib/place-match.mjs";

function parseArg(name) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1) return process.argv[idx + 1];
  const prefixed = process.argv.find((a) => a.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : undefined;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node --env-file=.env.local scripts/promote-happenings.mjs [options]

Promotes approved happenings_staging rows into happenings + happening_sources,
then marks the staging row extraction_status='promoted'. Idempotent — safe to
re-run.

Options:
  --batch-id <id>   Only promote staging rows from this batch_id (default: all
                     approved, un-promoted rows across every batch).

Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the env
(server-only key — happenings_staging has no anon write policy).
`);
  process.exit(0);
}

const BATCH_ID = parseArg("batch-id");

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "[promote-happenings] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
      "Run with: node --env-file=.env.local scripts/promote-happenings.mjs"
  );
  process.exit(1);
}

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
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

// Columns copied from happenings_staging onto the promoted happenings row.
// Mirrors scraper/happenings_research.py's build_full_record() output shape
// (minus batch_id/extraction_*/approved/validation_errors, which are
// staging-only bookkeeping, not app-facing columns).
const HAPPENINGS_COLUMNS = [
  "slug",
  "title",
  "summary",
  "kind",
  "category",
  "scope",
  "editorial_tag",
  "saving_label",
  "saving_amount",
  "currency",
  "is_free",
  "promo_code",
  "redemption_note",
  "eligibility",
  "eligibility_note",
  "allowance_note",
  "starts_at",
  "ends_at",
  "recurrence",
  "time_note",
  "booking_opens_at",
  "sellout_risk",
  "sellout_note",
  "venue_name",
  "address",
  "district",
  "city",
  "region",
  "country_code",
  "lat",
  "lng",
  "booking_url",
  "cta_label",
  "source_name",
  "source_url",
  "confidence",
  "priority",
  "status",
  "verified_at",
];

// Staging rows are LLM-extracted from scraped pages — booking_url/source_url
// aren't validated before landing in happenings_staging, so drop anything
// that isn't a real http(s) URL here rather than promote it straight
// through to a column the app hands to window.open/location (see
// scripts/lib/http-url.mjs and lib/http/safe-url.ts, its app-side twin).
const URL_COLUMNS = new Set(["booking_url", "source_url"]);

function buildHappeningRow(staging) {
  const row = {};
  for (const col of HAPPENINGS_COLUMNS) {
    if (staging[col] === undefined || staging[col] === null) continue;
    row[col] = URL_COLUMNS.has(col) ? httpUrlOrNull(staging[col]) : staging[col];
  }
  // A promoted row is, by definition, freshly verified right now.
  row.status = row.status ?? "live";
  return row;
}

// Edinburgh places a promoted row can be linked to, fetched once and only if a
// row actually needs it. Linking is best-effort: a failed fetch just promotes
// the rows unlinked (scripts/link-happening-places.mjs backfills them later).
let placeIndexPromise = null;
async function fetchEdinburghPlaces() {
  const PAGE_SIZE = 1000;
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await rest(`${EDINBURGH_PLACES_QUERY}&limit=${PAGE_SIZE}&offset=${offset}`);
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

function getPlaceIndex() {
  placeIndexPromise ??= fetchEdinburghPlaces()
    .then((rows) => buildPlaceIndex(rows))
    .catch((err) => {
      console.error(`[promote-happenings] WARN: place lookup failed, promoting without place links: ${err.message}`);
      return null;
    });
  return placeIndexPromise;
}

// Same unique-match-only rule as link-happening-places.mjs, so a deal with no
// photo of its own borrows its venue's. Never overrides: a row that already
// carries a place_id keeps it, and no match leaves the column out of the
// upsert so an existing link on the row survives re-promotion.
async function linkPlace(row) {
  if (row.place_id) return;
  const index = await getPlaceIndex();
  if (!index) return;
  const match = matchHappening(index, row);
  if (match.status === "linked") row.place_id = match.place.id;
}

async function fetchApprovedUnpromotedStaging() {
  // PostgREST caps a single response at 1000 rows by default — page
  // defensively (see promote-places.mjs, which hit this cap for real
  // on the Scotland batch).
  const PAGE_SIZE = 1000;
  const rows = [];
  const batchFilter = BATCH_ID ? `&batch_id=eq.${encodeURIComponent(BATCH_ID)}` : "";
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await rest(
      `happenings_staging?approved=eq.true&extraction_status=neq.promoted${batchFilter}` +
        `&select=*&limit=${PAGE_SIZE}&offset=${offset}`
    );
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function main() {
  const stagingRows = await fetchApprovedUnpromotedStaging();

  if (!stagingRows || stagingRows.length === 0) {
    console.log(
      `[promote-happenings] nothing to promote — no approved, un-promoted staging rows` +
        (BATCH_ID ? ` for batch_id=${BATCH_ID}.` : ".")
    );
    return;
  }

  console.log(`[promote-happenings] found ${stagingRows.length} staging row(s) to promote.`);

  const results = [];
  let failed = 0;

  for (const staging of stagingRows) {
    if (!staging.slug || !staging.title) {
      console.error(`[promote-happenings] SKIP ${staging.id} (batch ${staging.batch_id}): missing slug or title`);
      failed += 1;
      continue;
    }

    const happeningRow = buildHappeningRow(staging);
    await linkPlace(happeningRow);
    let promoted;
    try {
      const rows = await rest("happenings?on_conflict=slug", {
        method: "POST",
        headers: { Prefer: "return=representation,resolution=merge-duplicates" },
        body: JSON.stringify(happeningRow),
      });
      promoted = rows?.[0];
    } catch (err) {
      console.error(`[promote-happenings] FAILED upserting "${staging.title}" (${staging.slug}): ${err.message}`);
      failed += 1;
      continue;
    }

    if (!promoted?.id) {
      console.error(`[promote-happenings] FAILED upserting "${staging.title}" (${staging.slug}): no id returned`);
      failed += 1;
      continue;
    }

    const happeningId = promoted.id;

    const fieldSources =
      staging.field_sources && typeof staging.field_sources === "object"
        ? Object.entries(staging.field_sources)
        : [];
    const sourceRows = fieldSources
      .filter(([, url]) => typeof url === "string" && url.length > 0)
      .map(([fieldName, url]) => ({
        happening_id: happeningId,
        staging_id: staging.id,
        field_name: fieldName,
        source_url: url,
        extractor: staging.extraction_model ?? null,
      }));

    if (sourceRows.length > 0) {
      try {
        await rest("happening_sources", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(sourceRows),
        });
      } catch (err) {
        console.error(`[promote-happenings] WARN: happening_sources insert failed for "${staging.title}": ${err.message}`);
      }
    }

    try {
      await rest(`happenings_staging?id=eq.${staging.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ happening_id: happeningId, extraction_status: "promoted" }),
      });
    } catch (err) {
      console.error(
        `[promote-happenings] WARN: promoted "${staging.title}" to happenings (${happeningId}) but failed to ` +
          `update happenings_staging: ${err.message}`
      );
    }

    results.push({ title: staging.title, slug: staging.slug, happening_id: happeningId });
    console.log(`[promote-happenings] OK  ${staging.title} (${staging.slug}) → ${happeningId}`);
  }

  console.log(`\n[promote-happenings] done. promoted=${results.length} failed=${failed}`);
  if (results.length > 0) console.table(results);
}

main().catch((err) => {
  console.error("[promote-happenings] fatal:", err);
  process.exit(1);
});
