#!/usr/bin/env node
/**
 * geocode-happenings.mjs — backfills `happenings.lat/lng` for live rows that
 * can't be put on the map: no coordinates of their own and no linked place
 * that has some. Matching rules live in scripts/lib/geocode-venue.mjs
 * (unit-tested); ambiguous and unmatched rows are printed by name and left
 * alone for a human.
 *
 * Run link-happening-places.mjs first: a place link is better than a bare
 * coordinate (it also brings the venue's photo and opening hours).
 *
 * Only `lat`/`lng` are written, and only where `lat` is still null. --dry-run
 * is the DEFAULT; this script NEVER deletes a row. Uses the Supabase REST API
 * directly with the service-role key, same as link-happening-places.mjs.
 *
 * Usage:
 *   node --env-file=.env.local scripts/geocode-happenings.mjs
 *   node --env-file=.env.local scripts/geocode-happenings.mjs --apply
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
 * NEXT_PUBLIC_MAPBOX_TOKEN.
 */

import { geocodeHappening } from "./lib/geocode-venue.mjs";

const APPLY = process.argv.includes("--apply");

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

if (!supabaseUrl || !serviceRoleKey || !mapboxToken) {
  console.error(
    "[geocode-happenings] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_MAPBOX_TOKEN. " +
      "Run with: node --env-file=.env.local scripts/geocode-happenings.mjs"
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
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function main() {
  const rows = await rest(
    "happenings?status=eq.live&lat=is.null&order=slug.asc&limit=5000" +
      "&select=id,slug,title,venue_name,address,scope,place_id,places(lat,lng)"
  );
  // A linked place with coordinates already puts the row on the map
  // (lib/explore/coords.ts's resolveHappeningCoords).
  const todo = (rows ?? []).filter((h) => h.places?.lat == null || h.places?.lng == null);
  console.log(`[geocode-happenings] ${todo.length} live happening(s) with no usable coordinates.`);

  const found = [];
  const ambiguous = [];
  const none = [];
  const skipped = [];
  for (const h of todo) {
    let result;
    try {
      result = await geocodeHappening(h, mapboxToken);
    } catch (err) {
      console.error(`[geocode-happenings] lookup failed for ${h.slug}: ${err.message}`);
      none.push(h);
      continue;
    }
    if (result.status === "found") found.push({ h, result });
    else if (result.status === "ambiguous") ambiguous.push({ h, result });
    else if (result.status === "skipped") skipped.push({ h, result });
    else none.push(h);
  }

  console.log(`\nFOUND (${found.length}) — ${APPLY ? "will write" : "would write"}:`);
  for (const { h, result } of found) {
    const what = result.via === "venue" ? `POI "${result.name}"` : `${result.via} "${h.address}"`;
    console.log(`  - "${h.title}" venue="${h.venue_name}" -> ${what} @ ${result.lat.toFixed(5)},${result.lng.toFixed(5)}`);
  }
  console.log(`\nAMBIGUOUS (${ambiguous.length}) — not written:`);
  for (const { h, result } of ambiguous) console.log(`  - "${h.title}" venue="${h.venue_name}": ${result.names.join(" | ")}`);
  console.log(`\nNO MATCH (${none.length}):`);
  for (const h of none) console.log(`  - "${h.title}" venue=${h.venue_name ? `"${h.venue_name}"` : "null"} scope=${h.scope}`);
  console.log(`\nSKIPPED (${skipped.length}): ${skipped.map(({ result }) => result.reason).join(", ") || "none"}`);

  if (!APPLY) {
    console.log("\n[geocode-happenings] DRY RUN — pass --apply to write lat/lng. Nothing written.");
    return;
  }
  let ok = 0;
  let failed = 0;
  for (const { h, result } of found) {
    try {
      // lat=is.null: never overwrite coordinates set since the read above.
      await rest(`happenings?id=eq.${h.id}&lat=is.null`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ lat: result.lat, lng: result.lng }),
      });
      ok += 1;
    } catch (err) {
      failed += 1;
      console.error(`[geocode-happenings] FAILED writing ${h.slug}: ${err.message}`);
    }
  }
  console.log(`\n[geocode-happenings] done: written=${ok} failed=${failed}`);
}

main().catch((err) => {
  console.error("[geocode-happenings] fatal:", err);
  process.exit(1);
});
