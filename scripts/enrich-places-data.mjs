#!/usr/bin/env node
/**
 * enrich-places-data.mjs — one-off (but idempotent/re-runnable) enrichment
 * pass over `places` that backfills two columns added by
 * `supabase/archive/add_places_ranking_signals.sql` but never populated:
 *
 *   1. image_quality  ('ok' | 'thin' | 'none') — hero-eligibility gate.
 *      Card.tsx requires 'ok' before it will render a photo hero; with
 *      every row still null, the hero always falls back to the
 *      no-photo placeholder. See plan-v1-home-pivot.md §11.
 *   2. detail_line — plain composed single-line fallback text (NOT the
 *      eventual LLM-authored voice-quality line — see plan §9.7) so no
 *      card ever renders a blank detail row.
 *
 * A third task used to backfill mention_count/mention_sources by rolling up
 * the reels pipeline's `social_posts.place_id` linkage — removed in the
 * 2026-09 cleanup along with Reels/social_posts itself. `mention_count` is
 * now a frozen historical signal (whatever it was last set to), never
 * updated by this script again.
 *
 * Uses the Supabase REST API directly (not @supabase/supabase-js) — that
 * client's mandatory Realtime/WebSocket init throws under plain Node 20
 * ("Node.js 20 detected without native WebSocket support"). Same approach
 * as scripts/promote-places.mjs.
 *
 * Idempotent: recomputes and overwrites both columns from source data every
 * run rather than accumulating/appending, so re-running mid-debug is safe.
 * Rows with no image_url stay 'none'; rows with no usable text are left
 * detail_line=null (not overwritten with junk).
 *
 * Usage:
 *   node --env-file=.env.local scripts/enrich-places-data.mjs
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and either SUPABASE_SERVICE_ROLE_KEY
 * (preferred, bypasses RLS) or NEXT_PUBLIC_SUPABASE_ANON_KEY (fallback —
 * works here because `places` has an anon_write policy, see
 * supabase/archive/add_places_columns.sql).
 */

import sharp from "sharp";

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const supabaseKey = serviceRoleKey || anonKey;
const usingServiceRole = Boolean(serviceRoleKey);

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "[enrich] Missing NEXT_PUBLIC_SUPABASE_URL / (SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY). " +
      "Run with: node --env-file=.env.local scripts/enrich-places-data.mjs"
  );
  process.exit(1);
}

console.log(`[enrich] using ${usingServiceRole ? "service role" : "anon"} key against ${supabaseUrl}`);

const headers = {
  apikey: supabaseKey,
  Authorization: `Bearer ${supabaseKey}`,
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

// PostgREST caps a single response at 1000 rows by default — page through
// with limit/offset until a short page signals the end (same pattern as
// promote-places.mjs, which hit exactly this bug once already).
async function fetchAll(pathWithQuery) {
  const PAGE_SIZE = 1000;
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const sep = pathWithQuery.includes("?") ? "&" : "?";
    const page = await rest(`${pathWithQuery}${sep}limit=${PAGE_SIZE}&offset=${offset}`);
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

// Bounded-concurrency map: runs `fn` over `items` with at most `limit` in
// flight at once. Plain implementation, no new dependency.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      done++;
      if (done % 200 === 0) console.log(`[enrich]   ... ${done}/${items.length}`);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------
// Task 1: image_quality
// ---------------------------------------------------------------------

const MIN_OK_WIDTH = 800;
const PROBE_RANGE_BYTES = 262144; // 256KB — generous margin over the 128KB
// floor suggested in the brief; some progressive/interlaced JPEGs need more
// of the file before sharp can find a SOF marker with the real dimensions.
const PROBE_TIMEOUT_MS = 8000;
// Two separate concurrency knobs: PATCH_CONCURRENCY governs writes to our
// own Supabase REST API (cheap, no external rate limit observed). image
// probes hit *other people's* servers — Wikimedia in particular enforces
// https://meta.wikimedia.org/wiki/User-Agent_policy and rate-limits hard.
// Confirmed directly: 18-wide concurrent probing against Wikimedia (even
// with a descriptive UA) produced 429s on the majority of requests with a
// `Retry-After: 11` header; a lower, gentler concurrency plus honoring
// Retry-After on retry cleared them reliably. This matters a lot here —
// no-marker Wikimedia rows needing a real probe are ~47% of all `places`.
const PATCH_CONCURRENCY = 18;
const PROBE_CONCURRENCY = 6;
const PROBE_USER_AGENT =
  "RoameoDataEnrichment/1.0 (https://roameo.app; jasbirjas.singh98@gmail.com) node-fetch";
const PROBE_MAX_RETRIES = 5;
const PROBE_MAX_BACKOFF_MS = 20000; // cap so one big Retry-After can't stall the batch too long

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseGoogleWidth(url) {
  // Google Places photo URLs encode requested width as e.g. "...=s4800-w800".
  // Observed forms: -w800, -w480, -w26 (all dash-prefixed digits before end
  // of string or next non-digit). Also tolerate a "w=" query-style variant
  // in case it shows up, even though none were observed in this dataset.
  const dash = url.match(/-w(\d+)(?:[^0-9]|$)/);
  if (dash) return Number(dash[1]);
  const query = url.match(/[?&]w=(\d+)/);
  if (query) return Number(query[1]);
  return null;
}

function parseWikimediaThumbWidth(url) {
  const m = url.match(/\/(\d+)px-/);
  return m ? Number(m[1]) : null;
}

async function probeImageWidth(url) {
  for (let attempt = 0; attempt <= PROBE_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Range: `bytes=0-${PROBE_RANGE_BYTES - 1}`,
          "User-Agent": PROBE_USER_AGENT,
        },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status === 503) {
        if (attempt < PROBE_MAX_RETRIES) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const rawBackoffMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 500 * 2 ** attempt + Math.random() * 250;
          await sleep(Math.min(rawBackoffMs, PROBE_MAX_BACKOFF_MS));
          continue;
        }
        return null;
      }
      // Some hosts ignore Range and just return the whole file (200 instead
      // of 206) — that's fine, we still get a valid (larger) buffer to probe.
      if (!res.ok && res.status !== 206) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const meta = await sharp(buf).metadata();
      return meta.width ?? null;
    } catch {
      return null; // network error, timeout, non-image response, truncated data, etc.
    }
  }
  return null;
}

async function classifyImageQuality(place) {
  const url = place.image_url;
  if (!url) return { quality: "none", probed: false };

  let host;
  try {
    host = new URL(url).host;
  } catch {
    return { quality: "thin", probed: false }; // unparseable URL — fail-safe, not 'none'
  }

  if (host === "lh3.googleusercontent.com") {
    const w = parseGoogleWidth(url);
    if (w !== null) return { quality: w >= MIN_OK_WIDTH ? "ok" : "thin", probed: false };
    // No width encoded — fall through to a real probe rather than guessing.
  }

  if (host === "upload.wikimedia.org") {
    const w = parseWikimediaThumbWidth(url);
    if (w !== null) return { quality: w >= MIN_OK_WIDTH ? "ok" : "thin", probed: false };
    // No thumbnail marker — direct/original upload, needs a real probe.
  }

  // Unrecognized host, or a recognized host that didn't yield a width from
  // the URL alone (Google without -wNNN, Wikimedia without /NNNpx-): probe.
  const width = await probeImageWidth(url);
  if (width === null) return { quality: "thin", probed: true }; // fail-safe per spec
  return { quality: width >= MIN_OK_WIDTH ? "ok" : "thin", probed: true };
}

// ---------------------------------------------------------------------
// Task 3: detail_line
// ---------------------------------------------------------------------

const DETAIL_LINE_MAX_LEN = 100;

function truncateAtWordBoundary(text, maxLen) {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  const slice = trimmed.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 40 ? slice.slice(0, lastSpace) : slice).trim();
}

function composeDetailLine(place) {
  if (place.description && place.description.trim()) {
    return truncateAtWordBoundary(place.description, DETAIL_LINE_MAX_LEN);
  }

  const parts = [];
  if (place.category && place.category.trim()) parts.push(place.category.trim());
  if (typeof place.rating === "number") parts.push(`${place.rating}★`);
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  console.log("[enrich] fetching all places...");
  const places = await fetchAll(
    "places?select=id,image_url,description,category,rating"
  );
  console.log(`[enrich] fetched ${places.length} places rows`);

  console.log(
    `[enrich] classifying image_quality for ${places.length} places (probe concurrency=${PROBE_CONCURRENCY})...`
  );
  const qualityStats = { ok: 0, thin: 0, none: 0, probed: 0, probedOk: 0, probedThin: 0, urlResolved: 0 };
  const classifications = await mapWithConcurrency(places, PROBE_CONCURRENCY, async (place) => {
    const { quality, probed } = await classifyImageQuality(place);
    qualityStats[quality] += 1;
    if (probed) {
      qualityStats.probed += 1;
      if (quality === "ok") qualityStats.probedOk += 1;
      if (quality === "thin") qualityStats.probedThin += 1;
    } else if (place.image_url) {
      qualityStats.urlResolved += 1;
    }
    return quality;
  });

  console.log("[enrich] image_quality classification done:", qualityStats);

  console.log("[enrich] composing detail_line + building patch payloads...");
  let detailLineCount = 0;
  let detailLineNullCount = 0;

  const patches = places.map((place, i) => {
    const detail_line = composeDetailLine(place);
    if (detail_line) detailLineCount += 1;
    else detailLineNullCount += 1;

    const body = {
      image_quality: classifications[i],
      detail_line,
    };
    return { id: place.id, body };
  });

  console.log(
    `[enrich] writing ${patches.length} PATCH requests (concurrency=${PATCH_CONCURRENCY})...`
  );
  const errors = [];
  await mapWithConcurrency(patches, PATCH_CONCURRENCY, async ({ id, body }) => {
    try {
      await rest(`places?id=eq.${id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      errors.push({ id, error: err.message });
      console.error(`[enrich] FAILED PATCH ${id}: ${err.message}`);
    }
  });

  console.log("\n=== enrich-places-data.mjs — final report ===");
  console.log(`Total places processed: ${places.length} (expected full pass, not a sample)`);
  console.log(`image_quality: ok=${qualityStats.ok} thin=${qualityStats.thin} none=${qualityStats.none}`);
  console.log(
    `  resolved from URL alone (Google -wNNN or Wikimedia /NNNpx-): ${qualityStats.urlResolved}`
  );
  console.log(
    `  required a real dimension probe: ${qualityStats.probed} (probed->ok=${qualityStats.probedOk}, probed->thin(incl. fetch/parse failures)=${qualityStats.probedThin})`
  );
  console.log(`detail_line written (non-null): ${detailLineCount}`);
  console.log(`detail_line left null: ${detailLineNullCount}`);
  console.log(`PATCH errors: ${errors.length}`);
  if (errors.length) console.log(JSON.stringify(errors, null, 2));
  console.log("=== end report ===");
}

main().catch((err) => {
  console.error("[enrich] FATAL:", err);
  process.exit(1);
});
