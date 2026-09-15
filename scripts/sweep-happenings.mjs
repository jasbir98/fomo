#!/usr/bin/env node
/**
 * sweep-happenings.mjs — the trust mechanism behind the "still current"
 * story for `happenings`. Two independent jobs, both read-mostly:
 *
 *   1. Auto-retire expired one-offs: flips `status` live -> dormant for rows
 *      where `recurrence->>'type' = 'once' AND ends_at < now()`. Rows with
 *      any other recurrence type (always/weekly/annual/dates) are NEVER
 *      flipped by this sweep — an annual fixture whose date has passed is
 *      simply next year's row, not a dead one.
 *
 *   2. --emit-worklist: prints JSON for rows that are past 1x their
 *      staleness budget (see STALENESS_BUDGET_DAYS below), grouped by
 *      source_name, for `scraper/happenings_research.py --mode verify` to
 *      consume. Without this, "checked 3 days ago" silently rots into
 *      "checked 4 months ago" and the whole "still current" badge becomes a
 *      lie nobody notices.
 *
 * --dry-run is the DEFAULT for the status-flip job — it only ever prints
 * what it WOULD flip until you pass --apply. --emit-worklist is always
 * read-only regardless of --dry-run/--apply (it never writes anything).
 *
 * This script NEVER deletes a row, and NEVER sets status='retired' —
 * retirement is a human judgment call after actually looking at a dead
 * source page, not something a cron job should decide unattended.
 *
 * Uses the Supabase REST API directly (not @supabase/supabase-js), same
 * reasoning as promote-japan-places.mjs (that client's mandatory
 * Realtime/WebSocket init throws under plain Node 20). Uses the
 * service-role key, same as promote-happenings.mjs, since flipping
 * `status` on `happenings` has no anon write policy.
 *
 * Usage:
 *   node --env-file=.env.local scripts/sweep-happenings.mjs
 *   node --env-file=.env.local scripts/sweep-happenings.mjs --apply
 *   node --env-file=.env.local scripts/sweep-happenings.mjs --emit-worklist > worklist.json
 *   node --env-file=.env.local scripts/sweep-happenings.mjs --emit-worklist \
 *     | python3 scraper/happenings_research.py --mode verify --batch-id edi-happenings-2026-09-12
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * (server-only, see lib/supabase/admin.ts — never NEXT_PUBLIC_).
 */

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node --env-file=.env.local scripts/sweep-happenings.mjs [options]

Two independent jobs:
  1. Flips status live -> dormant for expired one-off happenings
     (recurrence.type='once' AND ends_at < now()). Never touches rows with
     any other recurrence type, and never deletes or sets 'retired'.
  2. --emit-worklist prints a JSON worklist (grouped by source_name) of rows
     overdue for re-verification, for happenings_research.py --mode verify.

Options:
  --dry-run         Print what WOULD be flipped, without writing. Default
                     behavior when neither --dry-run nor --apply is given.
  --apply           Actually flip status live -> dormant for expired one-offs.
  --emit-worklist   Print the re-verification worklist as JSON and exit.
                     Always read-only, independent of --dry-run/--apply.

Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the env.
`);
  process.exit(0);
}

const EMIT_WORKLIST = process.argv.includes("--emit-worklist");
const APPLY = process.argv.includes("--apply");
// --dry-run is the default: only --apply opts into actually writing.
const DRY_RUN = !APPLY;

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "[sweep-happenings] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
      "Run with: node --env-file=.env.local scripts/sweep-happenings.mjs"
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

// --- job 1: auto-retire expired one-offs -----------------------------------

async function findExpiredOnceRows() {
  const nowIso = new Date().toISOString();
  // recurrence->>'type'=eq.once AND ends_at < now() AND still marked live —
  // no point re-flipping an already-dormant/retired row.
  return fetchAllPages(
    `happenings?status=eq.live&recurrence->>type=eq.once&ends_at=lt.${encodeURIComponent(nowIso)}` +
      `&select=id,slug,title,ends_at,status`
  );
}

// Season-bound rows (festival concessions etc.) are usually "always" rows
// with no ends_at, so the one-off rule above never sees them. Returns null
// when supabase/add_season_valid_until.sql hasn't been run yet, so the sweep
// keeps working without the column.
async function findPastSeasonRows() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
  try {
    return await fetchAllPages(
      `happenings?status=eq.live&season_valid_until=lt.${today}&select=id,slug,title,season_valid_until,status`
    );
  } catch (err) {
    if (/season_valid_until/.test(err.message)) return null;
    throw err;
  }
}

async function flipToDormant(rows) {
  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await rest(`happenings?id=eq.${row.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "dormant" }),
      });
      ok += 1;
      console.log(`[sweep-happenings] dormant  ${row.slug} (ended ${row.ends_at})`);
    } catch (err) {
      failed += 1;
      console.error(`[sweep-happenings] FAILED flipping ${row.slug}: ${err.message}`);
    }
  }
  return { ok, failed };
}

async function runRetireJob() {
  const expired = await findExpiredOnceRows();
  const pastSeason = await findPastSeasonRows();
  if (pastSeason === null) {
    console.log("[sweep-happenings] season_valid_until column missing — skipping season check.");
  } else {
    const seen = new Set(expired.map((row) => row.id));
    for (const row of pastSeason) {
      if (seen.has(row.id)) continue;
      expired.push({ ...row, ends_at: `season ${row.season_valid_until}` });
    }
  }

  if (expired.length === 0) {
    console.log("[sweep-happenings] no expired one-off happenings to retire.");
    return;
  }

  console.log(
    `[sweep-happenings] ${expired.length} expired one-off happening(s) ${DRY_RUN ? "would be" : "will be"} flipped live -> dormant:`
  );
  for (const row of expired) {
    console.log(`  - ${row.slug} (ended ${row.ends_at})`);
  }

  if (DRY_RUN) {
    console.log("[sweep-happenings] DRY RUN — pass --apply to actually flip these. Nothing written.");
    return;
  }

  const { ok, failed } = await flipToDormant(expired);
  console.log(`[sweep-happenings] retire job done: succeeded=${ok} failed=${failed}`);
}

// --- job 2: --emit-worklist -------------------------------------------------

// Staleness budget by kind, in days — how long a row's verified_at may
// age before it's due for re-verification. A `deal` (a promo code, a
// discount) rots fastest — venues change codes/prices often; a `festival`
// (an annual, well-publicized fixture) rots slowest.
const STALENESS_BUDGET_DAYS = {
  deal: 21,
  free_access: 60,
  festival: 120,
};
const DEFAULT_STALENESS_BUDGET_DAYS = 21; // fallback for an unrecognized/missing kind — err toward re-checking sooner.

// Regardless of kind, anything whose NEXT occurrence is within 7 days must
// have been verified within the last 14 days — an imminent happening with a
// stale check is exactly the "user shows up and it's wrong" failure mode
// this whole pipeline exists to prevent.
const IMMINENT_WINDOW_DAYS = 7;
const IMMINENT_VERIFY_BUDGET_DAYS = 14;

function daysAgo(iso) {
  if (!iso) return Infinity; // never verified -> always overdue.
  const ms = Date.now() - new Date(iso).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function daysUntil(iso) {
  if (!iso) return Infinity;
  const ms = new Date(iso).getTime() - Date.now();
  return ms / (1000 * 60 * 60 * 24);
}

function nextOccurrenceIso(row) {
  // starts_at is the only occurrence date we can reason about generically
  // across recurrence types without reimplementing recurrence math here —
  // annual/weekly/dates rows without a starts_at just fall back to "not
  // imminent" for this check, which only widens (never narrows) who counts
  // as due, since the plain per-kind budget below still applies to them.
  return row.starts_at ?? null;
}

function isOverdue(row) {
  const kind = row.kind;
  const budget = STALENESS_BUDGET_DAYS[kind] ?? DEFAULT_STALENESS_BUDGET_DAYS;
  const age = daysAgo(row.verified_at);
  if (age > budget) return true;

  const untilNext = daysUntil(nextOccurrenceIso(row));
  if (untilNext <= IMMINENT_WINDOW_DAYS && age > IMMINENT_VERIFY_BUDGET_DAYS) return true;

  return false;
}

async function runEmitWorklist() {
  const rows = await fetchAllPages(
    `happenings?status=eq.live&select=slug,title,kind,source_url,source_name,starts_at,verified_at`
  );

  const overdue = rows.filter(isOverdue);

  const grouped = {};
  for (const row of overdue) {
    const key = row.source_name || "(unknown source)";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({ slug: row.slug, source_url: row.source_url, title: row.title });
  }

  // Flatten back into the flat worklist shape happenings_research.py
  // --mode verify expects ([{slug, source_url, title}]), but keep the
  // grouping order (by source_name) so items sharing a source land next to
  // each other — cheaper for the research script's own search budget.
  const worklist = Object.values(grouped).flat();

  console.error(
    `[sweep-happenings] ${overdue.length} of ${rows.length} live happening(s) are overdue for re-verification, ` +
      `across ${Object.keys(grouped).length} source(s).`
  );
  console.log(JSON.stringify(worklist, null, 2));
}

async function main() {
  if (EMIT_WORKLIST) {
    await runEmitWorklist();
    return;
  }
  await runRetireJob();
}

main().catch((err) => {
  console.error("[sweep-happenings] fatal:", err);
  process.exit(1);
});
