#!/usr/bin/env -S npx tsx
/**
 * scripts/review-deals.ts — the daily deal review: take stale and finished
 * deals off the live feed, and list anything that looks wrong for a person to
 * check. Runs in .github/workflows/daily-deal-review.yml right after
 * scraper/recheck_live.py; docs/weekly-pipeline.md ("Daily deal review")
 * explains the rules in plain English.
 *
 *   npx tsx --env-file=.env.local scripts/review-deals.ts [--dry-run]
 *
 * Reads every `kind = 'deal'`, `status = 'live'` happening and classifies it
 * with lib/happenings/deal-review.ts (all the rules live there, tested):
 *
 *   retire   the deal has ended            -> status 'retired'
 *   dormant  unverified for 30+ days, or outside Edinburgh -> status 'dormant'
 *   flagged  not a genuine deal, likely duplicate (report only)
 *   new      created in the last 24 hours, with their flags (report only)
 *
 * WRITES. Only the retire and dormant changes are written, as a status change
 * (never a DELETE), in batches, with `status=eq.live` repeated in the filter so
 * a row someone edited a moment ago is left alone. If a run would change more
 * than MAX_CHANGES rows nothing is written and the process exits 1 with the
 * list printed: that many in a day is more likely a bug (or a recheck outage
 * that left every `verified_at` old) than reality. No AI calls.
 *
 * DROUGHT ALARM. After the review, if no deal row (any status) has a `created_at`
 * in the last 7 days (`dealDrought`), a clear "No new deals" section is printed and
 * added to the run summary, and the process exits 1 even though everything else
 * succeeded. The alarm is checked and printed BEFORE the writes but the exit
 * comes AFTER them, so the retire and dormant changes are always made first (the
 * workflow's review is its last step, so exiting non-zero only fails the job).
 * `--dry-run` prints the same section but does not change the exit code.
 *
 * `--dry-run` writes nothing and always exits 0, even over the cap or in a
 * drought, so the report can be read.
 *
 * DB ACCESS. Plain `fetch` against PostgREST with the service-role key, not
 * @supabase/supabase-js, for the reason given in scripts/finds.ts (its
 * Realtime init throws under plain Node 20). Needs NEXT_PUBLIC_SUPABASE_URL (or
 * SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  DROUGHT_DAYS,
  MAX_CHANGES,
  NEW_WINDOW_HOURS,
  STALE_DORMANT_DAYS,
  dealDrought,
  reviewDeals,
  type DroughtResult,
  type DealVerdict,
  type ReviewableDeal,
} from "@/lib/happenings/deal-review";

const { values: args } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
const DRY_RUN = args["dry-run"] === true;

// --- Supabase REST ---------------------------------------------------------

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

async function rest<T = unknown>(method: "GET" | "PATCH", path: string, body?: unknown, prefer?: string): Promise<T> {
  const headers: Record<string, string> = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  let res: Response;
  // sb_secret_ keys: the gateway mints a short-lived JWT per request and clock
  // skew occasionally rejects it (PGRST303). Transient: retry before failing.
  for (let attempt = 1; ; attempt++) {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status !== 401 || attempt === 4) break;
    if (!(await res.clone().text()).includes("PGRST303")) break;
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : []) as T;
}

/** GET every row, paging past PostgREST's 1000-row cap. `path` must already carry a stable `order`. */
async function restAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await rest<T[]>("GET", `${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${offset}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// --- report ----------------------------------------------------------------

/** A table cell: no pipes or newlines, which would break the Markdown row. */
const cell = (s: string | null | undefined) => (s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim() || "-";

function table(rows: DealVerdict[], reasonOf: (v: DealVerdict) => string): string {
  if (rows.length === 0) return "_none_\n";
  const lines = ["| title | venue | reason | id | source |", "| --- | --- | --- | --- | --- |"];
  for (const v of rows) {
    const d = v.deal;
    lines.push(`| ${cell(d.title)} | ${cell(d.venue_name)} | ${cell(reasonOf(v))} | ${d.id} | ${cell(d.source_url)} |`);
  }
  return lines.join("\n") + "\n";
}

const flagText = (v: DealVerdict) => v.flags.map((f) => `${f.flag}: ${f.detail}`).join("; ");

function buildReport(review: ReturnType<typeof reviewDeals>, mode: string): string {
  const sections = [
    `### Daily deal review (${mode})`,
    "",
    `${review.verdicts.length} live deals: ${review.retire.length} to retire, ${review.dormant.length} to make dormant, ` +
      `${review.flagged.length} flagged, ${review.newToday.length} new in the last ${NEW_WINDOW_HOURS}h.`,
    "",
  ];
  if (review.overCap) {
    sections.push(
      `**OVER THE CAP:** ${review.changeCount} changes is more than ${MAX_CHANGES}. ` +
        `${DRY_RUN ? "A real run would write" : "Wrote"} nothing and fail. Check the lists below.`,
      ""
    );
  }
  sections.push(
    `#### Retire (ended): ${review.retire.length}`,
    "",
    table(review.retire, (v) => v.reason ?? ""),
    `#### Dormant (unverified ${STALE_DORMANT_DAYS}+ days, or outside Edinburgh): ${review.dormant.length}`,
    "",
    table(review.dormant, (v) => v.reason ?? ""),
    `#### Flagged, no change made: ${review.flagged.length}`,
    "",
    table(review.flagged, flagText),
    `#### New in the last ${NEW_WINDOW_HOURS}h: ${review.newToday.length}`,
    "",
    table(review.newToday, (v) => flagText(v) || v.reason || "no flags")
  );
  return sections.join("\n");
}

// --- drought alarm ---------------------------------------------------------

/**
 * The newest deal's created_at, any status. One row is enough: `dealDrought` only
 * needs to know whether the newest is inside the window. Returns null if the read
 * failed, so a blip in the check can never fail the job as a false alarm.
 */
async function checkDrought(now: Date): Promise<DroughtResult | null> {
  try {
    const rows = await rest<{ created_at: string | null; kind: string | null }[]>(
      "GET",
      "happenings?select=created_at,kind&kind=eq.deal&created_at=not.is.null&order=created_at.desc&limit=1"
    );
    return dealDrought(rows, now);
  } catch (err) {
    console.error(`[review-deals] drought check skipped: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function droughtSection(d: DroughtResult): string {
  const last = d.newest ? `${d.newest.slice(0, 10)} (${d.daysSince} days ago)` : "never";
  return [
    `### DROUGHT: no new deals in ${DROUGHT_DAYS} days`,
    "",
    `No deal row has been created in the last ${DROUGHT_DAYS} days. The newest was created ${last}.`,
    "Nothing is reaching the feed: check the daily deals run (daily-deals.yml), the review digest and `DEAL_AUTO_PUBLISH`, and approve anything waiting.",
    "This job fails on purpose until a deal is created, even though the review above completed.",
    "",
  ].join("\n");
}

// --- writes ----------------------------------------------------------------

const BATCH = 50;

/**
 * Soft-change `ids` to `status`. `status=eq.live` is repeated in the filter so a
 * row that someone retired, edited or restored since we read it is skipped, and
 * the representation comes back so the log shows what actually changed.
 */
async function setStatus(ids: string[], status: "retired" | "dormant"): Promise<string[]> {
  const changed: string[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const rows = await rest<{ id: string }[]>(
      "PATCH",
      `happenings?id=in.(${batch.join(",")})&status=eq.live&select=id`,
      { status },
      "return=representation"
    );
    changed.push(...rows.map((r) => r.id));
  }
  return changed;
}

// --- main ------------------------------------------------------------------

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("[review-deals] NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
    process.exit(1);
  }

  const now = new Date();
  const deals = await restAll<ReviewableDeal>("happenings?select=*&kind=eq.deal&status=eq.live&order=id.asc");
  const review = reviewDeals(deals, now);

  const mode = DRY_RUN ? "dry run" : review.overCap ? "NOT applied, over cap" : "applied";
  const report = buildReport(review, mode);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");

  const drought = await checkDrought(now);
  const inDrought = drought?.drought === true;
  if (inDrought) {
    const section = droughtSection(drought);
    console.log(section);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, section + "\n");
  }

  if (DRY_RUN) return;
  if (review.overCap) {
    console.error(`[review-deals] ${review.changeCount} changes is over the cap of ${MAX_CHANGES}: wrote nothing.`);
    process.exit(1);
  }

  for (const [status, verdicts] of [
    ["retired", review.retire],
    ["dormant", review.dormant],
  ] as const) {
    if (verdicts.length === 0) continue;
    const changed = await setStatus(verdicts.map((v) => v.deal.id), status);
    const byId = new Map(verdicts.map((v) => [v.deal.id, v]));
    for (const id of changed) console.log(`[review-deals] ${status}  ${byId.get(id)?.deal.title} (${id}): ${byId.get(id)?.reason}`);
    const skipped = verdicts.length - changed.length;
    if (skipped > 0) console.log(`[review-deals] ${skipped} ${status} change(s) skipped: no longer live when written.`);
  }

  // Last, so the review's own writes are never skipped by the alarm.
  if (inDrought) {
    console.error(`::error title=No new deals::No deal created in the last ${DROUGHT_DAYS} days (newest: ${drought?.newest ?? "none"}).`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[review-deals] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
