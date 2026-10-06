#!/usr/bin/env node
/**
 * link-happening-places.mjs — backfills `happenings.place_id` for live rows
 * that have none, by matching `venue_name` (else a venue read off the title)
 * against the Edinburgh `places` catalogue. A deal with no photo of its own
 * then shows its venue's photo instead of a category stock image: the feed
 * and the happening detail route already fall back to the linked place's
 * `image_url` (withPlaceImageFallback in app/api/feed/route.ts and
 * app/api/happenings/[id]/route.ts).
 *
 * The matching rules live in scripts/lib/place-match.mjs (unit-tested). Only a
 * UNIQUE match at its best tier is ever linked; ambiguous and unmatched rows
 * are printed by name and left alone for a human.
 *
 * Only `place_id` is written, and only where it is currently null — never
 * `image_url`, never an existing link. --dry-run is the DEFAULT; this script
 * NEVER deletes a row.
 *
 * Linking also changes grouping: live deals that resolve to the same place
 * collapse into one venue card in the Deals feed (buildDealsSection in
 * app/api/feed/route.ts). That is the intended behaviour, but run
 * dedupe-happenings.mjs first so duplicate offers don't inflate a group.
 *
 * Uses the Supabase REST API directly (not @supabase/supabase-js), same
 * reasoning as sweep-happenings.mjs, with the service-role key since
 * `happenings` has no anon write policy.
 *
 * Usage:
 *   node --env-file=.env.local scripts/link-happening-places.mjs
 *   node --env-file=.env.local scripts/link-happening-places.mjs --apply
 *   node --env-file=.env.local scripts/link-happening-places.mjs --only-with-image
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * (server-only, see lib/supabase/admin.ts — never NEXT_PUBLIC_).
 */

import { EDINBURGH_PLACES_QUERY, buildPlaceIndex, matchHappening } from "./lib/place-match.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node --env-file=.env.local scripts/link-happening-places.mjs [options]

Sets place_id on live happenings that have none, by matching venue_name (else
the title's leading words) to an Edinburgh place. Links only a unique match;
prints linked / ambiguous / no-match lists. Never overwrites an existing
place_id or image_url, never deletes.

Options:
  --dry-run          Print what WOULD be linked, without writing. Default
                      behavior when neither --dry-run nor --apply is given.
  --apply            Actually write place_id.
  --only-with-image  Only link to a place that has a photo (default: any
                      unique match, since a link also powers venue grouping
                      and the place page's "Offers here").

Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the env.
`);
  process.exit(0);
}

const APPLY = process.argv.includes("--apply");
// --dry-run is the default: only --apply opts into actually writing.
const DRY_RUN = !APPLY;
const ONLY_WITH_IMAGE = process.argv.includes("--only-with-image");

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "[link-happening-places] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
      "Run with: node --env-file=.env.local scripts/link-happening-places.mjs"
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

async function fetchAllPages(path) {
  // PostgREST caps a single response at 1000 rows by default.
  const PAGE_SIZE = 1000;
  const rows = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await rest(`${path}${sep}limit=${PAGE_SIZE}&offset=${offset}`);
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

function describePlace(place) {
  return `${place.name} [${place.image ? "photo" : "NO photo"}]`;
}

async function main() {
  const happenings = await fetchAllPages(
    `happenings?status=eq.live&place_id=is.null&order=slug.asc` +
      `&select=id,slug,title,venue_name,scope,lat,lng,image_url`
  );
  if (happenings.length === 0) {
    console.log("[link-happening-places] no live happenings without a place_id.");
    return;
  }

  const index = buildPlaceIndex(await fetchAllPages(EDINBURGH_PLACES_QUERY));
  console.log(
    `[link-happening-places] ${happenings.length} live happening(s) without a place_id; ` +
      `${index.places.length} Edinburgh place(s) to match against.`
  );

  const linked = [];
  const ambiguous = [];
  const noMatch = [];
  const skippedNoImage = [];
  for (const h of happenings) {
    const result = matchHappening(index, h);
    if (result.status === "linked") {
      if (ONLY_WITH_IMAGE && !result.place.image) skippedNoImage.push({ h, result });
      else linked.push({ h, result });
    } else if (result.status === "ambiguous") {
      ambiguous.push({ h, result });
    } else {
      noMatch.push(h);
    }
  }

  console.log(`\nLINKED (${linked.length}) — ${DRY_RUN ? "would link" : "will link"}:`);
  for (const { h, result } of linked) {
    const flags = [result.tier, `via ${result.via}`, result.tieBroken ? "tie broken by photo" : null].filter(Boolean).join(", ");
    console.log(`  - "${h.title}" (${h.slug}) venue="${result.venue}" -> ${describePlace(result.place)}  (${flags})`);
  }

  if (skippedNoImage.length > 0) {
    console.log(`\nSKIPPED, matched place has no photo (${skippedNoImage.length}, --only-with-image):`);
    for (const { h, result } of skippedNoImage) {
      console.log(`  - "${h.title}" (${h.slug}) -> ${describePlace(result.place)}`);
    }
  }

  console.log(`\nAMBIGUOUS (${ambiguous.length}) — not linked:`);
  for (const { h, result } of ambiguous) {
    console.log(`  - "${h.title}" (${h.slug}) venue="${result.venue}" (${result.tier}): ${result.candidates.map(describePlace).join(" | ")}`);
  }

  console.log(`\nNO MATCH (${noMatch.length}):`);
  for (const h of noMatch) {
    console.log(`  - "${h.title}" (${h.slug}) venue_name=${h.venue_name ? `"${h.venue_name}"` : "null"} scope=${h.scope}`);
  }

  if (linked.length === 0) {
    console.log("\n[link-happening-places] nothing to link.");
    return;
  }
  if (DRY_RUN) {
    console.log("\n[link-happening-places] DRY RUN — pass --apply to write place_id. Nothing written.");
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const { h, result } of linked) {
    try {
      // place_id=is.null in the filter: never overwrite a link someone set
      // between the read above and this write.
      await rest(`happenings?id=eq.${h.id}&place_id=is.null`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ place_id: result.place.id }),
      });
      ok += 1;
    } catch (err) {
      failed += 1;
      console.error(`[link-happening-places] FAILED linking ${h.slug}: ${err.message}`);
    }
  }
  console.log(`\n[link-happening-places] done: linked=${ok} failed=${failed}`);
}

main().catch((err) => {
  console.error("[link-happening-places] fatal:", err);
  process.exit(1);
});
