#!/usr/bin/env node
/**
 * apply-happening-enrichment.mjs -- turns evidence-gated extractions into
 * `happenings` updates (step 4 of docs/plans/2026-10-07-data-enrichment.md).
 *
 * Inputs (all under --out-dir, default scraper/out/enrich-<today>):
 *   checked.json   from scripts/check-happening-extractions.mjs
 *   review.json    optional, from the reviewer agent:
 *                  [{ id, field, verdict: "ok"|"reject", note }]
 *                  verdict "reject" drops that proposal; anything else keeps it.
 *   pages-index.json  optional, from scraper/fetch_happening_pages.py (for the
 *                  "blocked pages" section of the report)
 * plus live rows read from Supabase REST (service role, read-only in dry run).
 *
 * Field -> column: price_text, includes, summary, time_note, redemption_note,
 * eligibility_note, venue_name, address (same names).
 *
 * Each remaining proposal is classified against the live row:
 *   FILL    target column is null/blank          -> written by --apply
 *   CHANGE  target holds a different non-empty value -> only written when
 *           listed in --apply-changes <file> ([{ id, field }], the ones a
 *           human approved). Equal values (ignoring case/whitespace) are
 *           dropped as no-ops.
 *
 * Modes:
 *   (default)               dry run: prints and writes happenings-report.md
 *                           (FILLS, CHANGES, blocked pages). Nothing written
 *                           to the database.
 *   --apply                 write FILLs: PATCH happenings?id=eq.<id> with the
 *                           filled columns, enrich_sources (existing jsonb
 *                           merged with {field: {url, quote}}) and enriched_at.
 *   --apply-changes <file>  write the approved CHANGEs too (alone, it writes
 *                           only those; with --apply, fills as well).
 *   --rollback <file>       restore the previous values recorded by a run.
 *
 * Safety: never deletes, never touches `status`. Every apply run first writes
 * <out-dir>/rollback-<timestamp>.json with the previous value of every column
 * it will change (including enrich_sources / enriched_at). Each PATCH is
 * conditional on the target columns still holding the values read, so a row
 * edited in the meantime is skipped, not overwritten.
 *
 * Usage:
 *   node --env-file=.env.local scripts/apply-happening-enrichment.mjs --out-dir scraper/out/enrich-2026-10-07
 *   node --env-file=.env.local scripts/apply-happening-enrichment.mjs --out-dir ... --apply
 *   node --env-file=.env.local scripts/apply-happening-enrichment.mjs --out-dir ... --apply-changes approved.json
 *   node --env-file=.env.local scripts/apply-happening-enrichment.mjs --rollback scraper/out/enrich-.../rollback-....json
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIELDS } from "./lib/extraction-gate.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag("--help") || flag("-h")) {
  console.log(`Usage: node --env-file=.env.local scripts/apply-happening-enrichment.mjs [options]

  --out-dir <dir>         default scraper/out/enrich-<today>; needs checked.json
  --review <file>         default <out-dir>/review.json if present
  --apply                 write FILLs (blank columns only) + enrich_sources + enriched_at
  --apply-changes <file>  [{id, field}] approved CHANGEs to write too
  --rollback <file>       restore previous values from a run's rollback file
  (no write flag)         dry run: prints and writes <out-dir>/happenings-report.md
Never deletes; never touches status.`);
  process.exit(0);
}

const APPLY = flag("--apply");
const CHANGES_FILE = opt("--apply-changes");
const ROLLBACK_FILE = opt("--rollback");
const today = new Date().toISOString().slice(0, 10);
const outDir = opt("--out-dir") ?? join("scraper", "out", `enrich-${today}`);

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "[apply-enrichment] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
      "Run with: node --env-file=.env.local scripts/apply-happening-enrichment.mjs"
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
    throw new Error(`${options.method ?? "GET"} ${path.slice(0, 80)} -> ${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function fetchAllPages(path) {
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

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const isBlank = (v) => v == null || (typeof v === "string" && v.trim() === "");
const same = (a, b) => String(a).replace(/\s+/g, " ").trim().toLowerCase() === String(b).replace(/\s+/g, " ").trim().toLowerCase();
const clip = (s, n = 90) => (s && s.length > n ? `${s.slice(0, n - 1)}...` : s);

/** PATCH with an optimistic guard: each column must still hold the value we read. */
async function patchGuarded(id, patch, expected) {
  const guards = Object.entries(expected)
    .map(([col, val]) => (val == null ? `${col}=is.null` : `${col}=eq.${encodeURIComponent(val)}`))
    .join("&");
  const rows = await rest(`happenings?id=eq.${id}${guards ? `&${guards}` : ""}&select=id`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  return Array.isArray(rows) ? rows.length : 0;
}

// --- rollback mode ----------------------------------------------------------
async function rollback(file) {
  const entries = readJson(file);
  let ok = 0;
  let failed = 0;
  for (const { id, previous } of entries) {
    try {
      await rest(`happenings?id=eq.${id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(previous),
      });
      ok += 1;
    } catch (err) {
      failed += 1;
      console.error(`[apply-enrichment] rollback FAILED for ${id}: ${err.message}`);
    }
  }
  console.log(`[apply-enrichment] rollback done: restored=${ok} failed=${failed} (from ${file})`);
}

// --- main -------------------------------------------------------------------
async function main() {
  if (ROLLBACK_FILE) return rollback(ROLLBACK_FILE);

  const checkedPath = join(outDir, "checked.json");
  if (!existsSync(checkedPath)) {
    console.error(`[apply-enrichment] ${checkedPath} not found. Run check-happening-extractions.mjs first.`);
    process.exit(1);
  }
  const checked = readJson(checkedPath);

  const reviewPath = opt("--review") ?? join(outDir, "review.json");
  const rejectedByReview = new Set();
  let reviewCount = 0;
  if (existsSync(reviewPath)) {
    for (const r of readJson(reviewPath)) {
      reviewCount += 1;
      if (r.verdict === "reject") rejectedByReview.add(`${r.id}:${r.field}`);
    }
  }

  const rows = await fetchAllPages(
    `happenings?status=eq.live&order=id.asc&select=id,slug,title,enrich_sources,enriched_at,${FIELDS.join(",")}`
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  const fills = [];
  const changes = [];
  const droppedByReview = [];
  const notLive = [];
  let noops = 0;
  for (const [id, { accepted }] of Object.entries(checked)) {
    const row = byId.get(id);
    if (!row) {
      if (Object.keys(accepted).length) notLive.push(id);
      continue;
    }
    for (const [field, p] of Object.entries(accepted)) {
      if (!FIELDS.includes(field)) continue;
      if (rejectedByReview.has(`${id}:${field}`)) {
        droppedByReview.push({ id, field, title: row.title });
        continue;
      }
      const current = row[field];
      const item = { id, slug: row.slug, title: row.title, field, current, value: p.value, quote: p.quote, url: p.url };
      if (isBlank(current)) fills.push(item);
      else if (same(current, p.value)) noops += 1;
      else changes.push(item);
    }
  }

  // Approved changes.
  let approved = [];
  if (CHANGES_FILE) {
    const wanted = new Set(readJson(CHANGES_FILE).map((a) => `${a.id}:${a.field}`));
    approved = changes.filter((c) => wanted.has(`${c.id}:${c.field}`));
    const missing = [...wanted].filter((k) => !approved.some((c) => `${c.id}:${c.field}` === k));
    if (missing.length) console.warn(`[apply-enrichment] ${missing.length} approved change(s) not found among proposals: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " ..." : ""}`);
  }

  // Blocked pages, for the report.
  let blocked = [];
  const indexPath = join(outDir, "pages-index.json");
  if (existsSync(indexPath)) blocked = readJson(indexPath).filter((p) => p.status !== "ok");

  writeReport({ fills, changes, blocked, droppedByReview, notLive, noops, reviewCount });

  console.log(
    `[apply-enrichment] ${fills.length} fill(s), ${changes.length} change(s) needing review, ` +
      `${noops} no-op(s), ${droppedByReview.length} dropped by review, ${blocked.length} blocked page(s).`
  );

  const toWrite = [...(APPLY ? fills : []), ...approved];
  if (!APPLY && !CHANGES_FILE) {
    console.log(`[apply-enrichment] DRY RUN: report at ${join(outDir, "happenings-report.md")}. Pass --apply to write fills. Nothing written.`);
    return;
  }
  if (toWrite.length === 0) {
    console.log("[apply-enrichment] nothing to write.");
    return;
  }

  // Group per row.
  const perRow = new Map();
  for (const item of toWrite) {
    if (!perRow.has(item.id)) perRow.set(item.id, []);
    perRow.get(item.id).push(item);
  }

  // Rollback file first, before any write.
  const now = new Date().toISOString();
  const rollbackEntries = [];
  const plans = [];
  for (const [id, items] of perRow) {
    const row = byId.get(id);
    const previous = {};
    const patch = {};
    const expected = {};
    const sources = { ...(row.enrich_sources ?? {}) };
    for (const it of items) {
      previous[it.field] = row[it.field] ?? null;
      expected[it.field] = row[it.field] ?? null;
      patch[it.field] = it.value;
      sources[it.field] = { url: it.url, quote: it.quote };
    }
    previous.enrich_sources = row.enrich_sources ?? null;
    previous.enriched_at = row.enriched_at ?? null;
    patch.enrich_sources = sources;
    patch.enriched_at = now;
    rollbackEntries.push({ id, slug: row.slug, previous });
    plans.push({ id, slug: row.slug, patch, expected });
  }
  const rollbackPath = join(outDir, `rollback-${now.replace(/[:.]/g, "-")}.json`);
  writeFileSync(rollbackPath, JSON.stringify(rollbackEntries, null, 2));
  console.log(`[apply-enrichment] rollback file: ${rollbackPath}`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const plan of plans) {
    try {
      const n = await patchGuarded(plan.id, plan.patch, plan.expected);
      if (n === 0) {
        skipped += 1;
        console.warn(`[apply-enrichment] skipped ${plan.slug}: row changed since it was read`);
      } else {
        ok += 1;
        console.log(`[apply-enrichment] updated ${plan.slug}: ${Object.keys(plan.patch).filter((k) => !["enrich_sources", "enriched_at"].includes(k)).join(", ")}`);
      }
    } catch (err) {
      failed += 1;
      console.error(`[apply-enrichment] FAILED ${plan.slug}: ${err.message}`);
    }
  }
  console.log(`[apply-enrichment] done: updated=${ok} skipped=${skipped} failed=${failed}. Undo: --rollback ${rollbackPath}`);
}

function writeReport({ fills, changes, blocked, droppedByReview, notLive, noops, reviewCount }) {
  const md = [];
  md.push(`# Happening enrichment report (${today})`, "");
  md.push(
    `Fills: ${fills.length}. Changes needing review: ${changes.length}. Identical (skipped): ${noops}. ` +
      `Dropped by reviewer: ${droppedByReview.length} (of ${reviewCount} verdicts). Blocked pages: ${blocked.length}.` +
      (notLive.length ? ` Rows no longer live: ${notLive.length}.` : ""),
    ""
  );
  md.push("## FILLS (column currently blank)", "");
  if (!fills.length) md.push("None.", "");
  for (const f of fills) {
    md.push(`- **${f.title}** \`${f.field}\`: ${clip(f.value, 200)}`, `  - evidence: "${clip(f.quote, 200)}" (${f.url ?? "no url"})`);
  }
  md.push("", "## CHANGES (column has a different value; needs approval)", "");
  if (!changes.length) md.push("None.", "");
  for (const c of changes) {
    md.push(
      `- **${c.title}** \`${c.field}\` (id ${c.id})`,
      `  - now: ${clip(c.current, 200)}`,
      `  - proposed: ${clip(c.value, 200)}`,
      `  - evidence: "${clip(c.quote, 200)}" (${c.url ?? "no url"})`
    );
  }
  if (droppedByReview.length) {
    md.push("", "## DROPPED BY REVIEWER", "");
    for (const d of droppedByReview) md.push(`- ${d.title} \`${d.field}\``);
  }
  md.push("", "## BLOCKED / FAILED PAGES", "");
  if (!blocked.length) md.push("None (or no pages-index.json).", "");
  for (const b of blocked) md.push(`- ${b.title ?? b.id}: ${b.status}, ${b.reason ?? "no reason"} (${b.url ?? "no url"})`);
  md.push("");
  writeFileSync(join(outDir, "happenings-report.md"), md.join("\n"));
}

main().catch((err) => {
  console.error("[apply-enrichment] fatal:", err);
  process.exit(1);
});
