#!/usr/bin/env node
/**
 * dedupe-happenings.mjs — finds live `happenings` that describe the same offer
 * at the same venue (two research batches phrasing one deal differently, so
 * the Deals feed shows it twice) and flips the weaker row live -> dormant.
 *
 * Duplicate rules and the keep order live in scripts/lib/happening-dedupe.mjs
 * (unit-tested): same kind, same eligibility (or one null), same price, same
 * venue identity. The survivor is the row with an image / place link, then
 * higher confidence, then newer verified_at, then the longer summary. Every
 * pair is printed with titles and the deciding reason so you can eyeball it.
 *
 * --dry-run is the DEFAULT — it only prints until you pass --apply. This
 * script NEVER deletes a row and NEVER sets status='retired' (that stays a
 * human call, see sweep-happenings.mjs); a wrongly dropped row is a one-line
 * `status = 'live'` undo.
 *
 * Run this BEFORE link-happening-places.mjs: a link is a "has a place link"
 * point in the keep order, so linking first would favour whichever duplicate
 * happened to match a place name.
 *
 * Uses the Supabase REST API directly (not @supabase/supabase-js), same
 * reasoning as sweep-happenings.mjs, with the service-role key since
 * `happenings` has no anon write policy.
 *
 * Usage:
 *   node --env-file=.env.local scripts/dedupe-happenings.mjs
 *   node --env-file=.env.local scripts/dedupe-happenings.mjs --apply
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * (server-only, see lib/supabase/admin.ts — never NEXT_PUBLIC_).
 */

import { findDuplicateGroups } from "./lib/happening-dedupe.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node --env-file=.env.local scripts/dedupe-happenings.mjs [options]

Flips the weaker row of each live duplicate pair live -> dormant. Never deletes
and never sets 'retired'.

Options:
  --dry-run   Print each pair (kept / dropped, with the reason) without
               writing. Default behavior when neither --dry-run nor --apply
               is given.
  --apply     Actually flip the dropped rows to status='dormant'.

Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the env.
`);
  process.exit(0);
}

const APPLY = process.argv.includes("--apply");
// --dry-run is the default: only --apply opts into actually writing.
const DRY_RUN = !APPLY;

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "[dedupe-happenings] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
      "Run with: node --env-file=.env.local scripts/dedupe-happenings.mjs"
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

function describe(row) {
  const extras = [
    row.venue_name ? `venue "${row.venue_name}"` : "no venue",
    row.eligibility ?? "no eligibility",
    row.saving_label ? `label "${row.saving_label}"` : null,
    `${row.confidence ?? "no"} confidence`,
    `verified ${row.verified_at ? row.verified_at.slice(0, 10) : "never"}`,
    row.image_url || row.place_id ? "has image/place" : "no image/place",
  ].filter(Boolean);
  return `"${row.title}" (${row.slug}) [${extras.join(", ")}]`;
}

async function main() {
  const rows = await fetchAllPages(
    `happenings?status=eq.live&order=slug.asc` +
      `&select=id,slug,title,summary,kind,eligibility,saving_amount,saving_label,is_free,venue_name,image_url,place_id,confidence,verified_at`
  );
  const groups = findDuplicateGroups(rows);

  if (groups.length === 0) {
    console.log(`[dedupe-happenings] no duplicate live happenings among ${rows.length} row(s).`);
    return;
  }

  const drops = groups.flatMap((g) => g.drops.map((d) => d.row));
  console.log(
    `[dedupe-happenings] ${groups.length} duplicate group(s) among ${rows.length} live row(s); ` +
      `${drops.length} row(s) ${DRY_RUN ? "would be" : "will be"} flipped live -> dormant:\n`
  );
  for (const { keep, drops: dropped } of groups) {
    console.log(`  KEEP  ${describe(keep)}`);
    for (const { row, reason } of dropped) {
      console.log(`  DROP  ${describe(row)}`);
      console.log(`        reason: kept row wins on ${reason}`);
    }
    console.log("");
  }

  if (DRY_RUN) {
    console.log("[dedupe-happenings] DRY RUN — pass --apply to flip the DROP rows to dormant. Nothing written.");
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const row of drops) {
    try {
      // status=eq.live in the filter: never touch a row that went dormant or
      // retired between the read above and this write.
      await rest(`happenings?id=eq.${row.id}&status=eq.live`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "dormant" }),
      });
      ok += 1;
      console.log(`[dedupe-happenings] dormant  ${row.slug}`);
    } catch (err) {
      failed += 1;
      console.error(`[dedupe-happenings] FAILED flipping ${row.slug}: ${err.message}`);
    }
  }
  console.log(`[dedupe-happenings] done: dormant=${ok} failed=${failed}`);
}

main().catch((err) => {
  console.error("[dedupe-happenings] fatal:", err);
  process.exit(1);
});
