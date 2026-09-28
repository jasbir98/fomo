#!/usr/bin/env node
/**
 * promote-places.mjs — promotes approved `places_staging` rows into the
 * shared `places` table, records per-field provenance in `place_sources`, and
 * marks each staging row as promoted.
 *
 * This script is country-agnostic: it promotes approved staging rows for
 * `--country-code` (default JP), tagging each new place with `--source`.
 *
 * Idempotent: only selects staging rows that are approved and not yet promoted,
 * so re-running after a partial failure or a new batch is safe.
 *
 * LIVE-DUPLICATE GUARD. Before inserting, each staging row is checked against
 * the places already live for the same country (and against rows promoted
 * earlier in the same run):
 *   - Same name under strict normalisation (case, a leading "the", punctuation)
 *     AND the same prefecture -> SKIPPED. The staging row is un-approved, with
 *     `place_id` set to the existing place and the reason in `rejected_reason`,
 *     so later runs don't retry it.
 *   - Same name only once parenthetical qualifiers are stripped (e.g.
 *     "Scottish National Gallery of Modern Art (Modern One)") -> PROMOTED, but
 *     listed as a possible duplicate for review, with the distance when both
 *     rows have coordinates.
 * The fuzzy rule deliberately never skips on its own: in the first Edinburgh
 * batch it also paired "The Haymarket (Nicholson's)", a pub, with "Haymarket",
 * the railway station across the road. Coordinates decide nothing either,
 * because some live Scotland rows carry collapsed coordinates from an earlier
 * pipeline bug. Provider-cache rows (source = "google") are not checked — they
 * are a TTL cache with no country set, not part of the curated catalog.
 * Pass --allow-live-duplicates to turn the guard off.
 *
 * WRITE KEY. `places`, `places_staging`, and `place_sources` all have no
 * anon/authenticated write policy (supabase/archive/harden_rls.sql removed it from
 * `places`; supabase/archive/lock_pipeline_tables.sql removes it from the other two).
 * SUPABASE_SERVICE_ROLE_KEY is therefore required — this script no longer
 * falls back to the anon key for writes.
 *
 * DESTINATION. `destination` is "<city or prefecture>, <country label>". For
 * neighbourhood-level batches, where `city` holds a neighbourhood like "Leith",
 * pass --destination-city Edinburgh so every row reads "Edinburgh, Scotland".
 *
 * Uses the Supabase REST API directly (not @supabase/supabase-js) to avoid that
 * client's mandatory Realtime/WebSocket init, which isn't available in plain
 * Node 20.
 *
 * Usage:
 *   node --env-file=.env.local scripts/promote-places.mjs
 *   node --env-file=.env.local scripts/promote-places.mjs --country-code GB --source seed-scotland-pipeline
 *   node --env-file=.env.local scripts/promote-places.mjs --country-code GB \
 *     --source seed-edinburgh-local --destination-city Edinburgh --dry-run
 *
 * --dry-run reports what would be promoted, skipped and flagged, and writes nothing.
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * (server-only key — places_staging/place_sources have no anon write policy).
 */

function parseArg(name) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx !== -1) return process.argv[idx + 1];
  const prefixed = process.argv.find((a) => a.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : undefined;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

// Which places_staging rows to promote — filtered by `places_staging.country`
// (that table has no `source` column; `source` only exists on the
// destination `places` table, see PLACES_COLUMNS/buildPlaceRow below).
const DEFAULT_COUNTRY_CODE = "JP";
const COUNTRY_CODE = (parseArg("country-code") ?? DEFAULT_COUNTRY_CODE).toUpperCase();

const DEFAULT_SOURCE = "seed-japan-pipeline";
const SOURCE = parseArg("source") ?? DEFAULT_SOURCE;
const DESTINATION_SUFFIX_OVERRIDE = parseArg("destination-suffix");
const DESTINATION_CITY_OVERRIDE = parseArg("destination-city");
const DRY_RUN = hasFlag("dry-run");
const ALLOW_LIVE_DUPLICATES = hasFlag("allow-live-duplicates");

// `places.country` -> the human-readable label used in the `destination`
// string (e.g. "Edinburgh, Scotland"), matching how the app's own
// destination strings read. Add an entry here for each new country's pipeline.
const COUNTRY_DESTINATION_LABEL = {
  JP: "Japan",
  GB: "Scotland",
};

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "[promote] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
      "places_staging and place_sources have no anon write policy, so the anon key " +
      "will not work here. Run with: node --env-file=.env.local scripts/promote-places.mjs"
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
  const cityOrPrefecture = DESTINATION_CITY_OVERRIDE ?? (staging.city || staging.prefecture);
  const destinationSuffix =
    DESTINATION_SUFFIX_OVERRIDE ?? COUNTRY_DESTINATION_LABEL[staging.country] ?? staging.country;
  row.destination =
    cityOrPrefecture && destinationSuffix ? `${cityOrPrefecture}, ${destinationSuffix}` : null;
  return row;
}

/** Case, a leading "the", and punctuation — but parenthetical content is kept. */
function strictName(name) {
  return (name ?? "").trim().toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
}

/** strictName with parenthetical qualifiers like "(Modern One)" removed first. */
function looseName(name) {
  return strictName((name ?? "").replace(/\s*\([^)]*\)/g, ""));
}

function distanceMetres(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

function addToIndex(index, keyFn, place) {
  const key = keyFn(place.name);
  if (!key) return;
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(place);
}

async function fetchPaged(pathWithoutPaging) {
  // PostgREST caps a single response at 1000 rows by default — without
  // pagination here, any batch bigger than that silently loses rows every
  // run (surfaced when the Scotland batch's 3371 approved rows only
  // promoted 1000 per invocation, requiring several manual re-runs).
  const PAGE_SIZE = 1000;
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await rest(`${pathWithoutPaging}&limit=${PAGE_SIZE}&offset=${offset}`);
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function main() {
  console.log(
    `[promote] country=${COUNTRY_CODE} source=${SOURCE} key=service-role` +
      `${DRY_RUN ? " DRY RUN (no writes)" : ""}${ALLOW_LIVE_DUPLICATES ? " duplicate-guard=OFF" : ""}`
  );

  const stagingRows = await fetchPaged(
    `places_staging?country=eq.${encodeURIComponent(COUNTRY_CODE)}&approved=eq.true&extraction_status=neq.promoted&select=*`
  );

  if (!stagingRows || stagingRows.length === 0) {
    console.log(`[promote] nothing to promote — no approved, un-promoted staging rows for country=${COUNTRY_CODE}.`);
    return;
  }
  console.log(`[promote] found ${stagingRows.length} staging row(s) to promote.`);

  const byStrict = new Map();
  const byLoose = new Map();
  if (!ALLOW_LIVE_DUPLICATES) {
    const live = await fetchPaged(
      `places?country=eq.${encodeURIComponent(COUNTRY_CODE)}&select=id,name,prefecture,lat,lng`
    );
    for (const place of live) {
      addToIndex(byStrict, strictName, place);
      addToIndex(byLoose, looseName, place);
    }
    console.log(`[promote] duplicate guard: checking against ${live.length} live place(s).`);
  }

  const results = [];
  const skipped = [];
  const flagged = [];
  let failed = 0;

  for (const staging of stagingRows) {
    if (!staging.name || !(staging.city || staging.prefecture)) {
      console.error(
        `[promote] SKIP ${staging.id} (${staging.dedupe_key}): missing name or city/prefecture`
      );
      failed += 1;
      continue;
    }

    if (!ALLOW_LIVE_DUPLICATES) {
      const exact = (byStrict.get(strictName(staging.name)) ?? []).find(
        (p) => (p.prefecture ?? "") === (staging.prefecture ?? "")
      );
      if (exact) {
        skipped.push({ name: staging.name, already_live_as: exact.name, existing_id: exact.id });
        console.log(`[promote] SKIP duplicate: "${staging.name}" is already live as "${exact.name}" (${exact.id})`);
        if (!DRY_RUN) {
          try {
            await rest(`places_staging?id=eq.${staging.id}`, {
              method: "PATCH",
              headers: { Prefer: "return=minimal" },
              body: JSON.stringify({
                approved: false,
                place_id: exact.id,
                rejected_reason: `duplicate of live place ${exact.id} ("${exact.name}")`,
              }),
            });
          } catch (err) {
            console.error(`[promote] WARN: could not mark "${staging.name}" as a duplicate: ${err.message}`);
          }
        }
        continue;
      }

      const fuzzy = (byLoose.get(looseName(staging.name)) ?? [])[0];
      if (fuzzy) {
        const bothHaveCoords =
          staging.lat != null && staging.lng != null && fuzzy.lat != null && fuzzy.lng != null;
        flagged.push({
          name: staging.name,
          possible_duplicate_of: fuzzy.name,
          existing_id: fuzzy.id,
          distance_m: bothHaveCoords
            ? Math.round(distanceMetres({ lat: staging.lat, lng: staging.lng }, { lat: fuzzy.lat, lng: fuzzy.lng }))
            : null,
        });
      }
    }

    const placeRow = buildPlaceRow(staging);

    if (DRY_RUN) {
      results.push({ name: staging.name, place_id: "(dry run)" });
      // Index the would-be row so same-name rows later in this run are caught too.
      const pending = { id: "(pending)", name: staging.name, prefecture: staging.prefecture, lat: staging.lat, lng: staging.lng };
      addToIndex(byStrict, strictName, pending);
      addToIndex(byLoose, looseName, pending);
      continue;
    }

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
    addToIndex(byStrict, strictName, inserted);
    addToIndex(byLoose, looseName, inserted);

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

  console.log(
    `\n[promote] done${DRY_RUN ? " (dry run — nothing written)" : ""}. ` +
      `promoted=${results.length} skipped_duplicates=${skipped.length} ` +
      `flagged_possible_duplicates=${flagged.length} failed=${failed}`
  );
  if (skipped.length > 0) {
    console.log("\n[promote] skipped — already live:");
    console.table(skipped);
  }
  if (flagged.length > 0) {
    console.log("\n[promote] promoted, but review — possible duplicates:");
    console.table(flagged);
  }
  if (results.length > 0 && !DRY_RUN) console.table(results);
}

main().catch((err) => {
  console.error("[promote] fatal:", err);
  process.exit(1);
});
