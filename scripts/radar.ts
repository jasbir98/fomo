#!/usr/bin/env -S npx tsx
/**
 * scripts/radar.ts - curate "Under the radar": the small hand-approved list of
 * lesser-known Edinburgh places, with one featured pick a week. Nothing is
 * shown in the app until you `approve` it. No AI is used anywhere here.
 *
 *   npx tsx --env-file=.env.local scripts/radar.ts <command> [options]
 *
 *   suggest [--limit=20]                          numbered candidates (read-only)
 *   approve <n|id> --why "..." [--limit=20] [--dry-run]
 *   feature <n|id> [--week YYYY-MM-DD] [--dry-run]
 *   list                                          current picks
 *   retire <n|id> [--dry-run]                     un-approve a pick
 *
 * NUMBERS. `approve` numbers are the rows `suggest` prints, re-derived from the
 * database each time (lib/radar/candidates.ts is deterministic), so pass the
 * SAME --limit to `approve` that you gave `suggest`. If you are unsure, use the
 * place id (a uuid) instead: `suggest` prints it with --ids. `feature` and
 * `retire` numbers are rows of `list`.
 *
 * WRITES. Writes happen unless you pass --dry-run (which prints what would
 * change and writes nothing), the same as scripts/finds.ts. `suggest` and
 * `list` never write. Needs supabase/add_place_radar.sql run first.
 *
 * WEEKS. A featured pick is keyed by the Monday (Europe/London) of its week.
 * `--week` takes any date and is rounded down to that week's Monday. Featuring
 * a pick clears any other pick featured for the same week.
 *
 * DB ACCESS. Plain `fetch` against `${NEXT_PUBLIC_SUPABASE_URL}/rest/v1` with
 * the service-role key (same as scripts/finds.ts), which is what lets it write
 * to `places` past the read-only RLS.
 */
import { parseArgs } from "node:util";
import { withThumbnail } from "@/lib/db/places";
import { formatCandidateTable, selectCandidates } from "@/lib/radar/candidates";
import { orderPicks } from "@/lib/radar/picks";
import { isMissingRadarColumn } from "@/lib/radar/safe";
import { RADAR_WHY_MAX_CHARS } from "@/lib/radar/types";
import { currentWeekStart, isDayDate, mondayOf } from "@/lib/radar/week";
import type { Place } from "@/lib/types";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

class RestError extends Error {
  constructor(
    public status: number,
    public body: string,
    message: string
  ) {
    super(message);
  }
}

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
  if (!res.ok) throw new RestError(res.status, text, `${method} ${path} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : []) as T;
}

/** GET every row, paging past PostgREST's 1000-row cap. `path` must carry a stable `order`. */
async function restAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await rest<T[]>("GET", `${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${offset}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

const SELECT = "select=*,place_photos(url,display_order)";
const NOT_EVENT_VENUE = "or=(source.is.null,source.neq.event-venue)";

/** The PostgREST error body is JSON `{code, message}`; turn a RestError into that shape for isMissingRadarColumn. */
function asDbError(err: unknown): unknown {
  if (!(err instanceof RestError)) return err;
  try {
    return JSON.parse(err.body);
  } catch {
    return { message: err.body };
  }
}

const MISSING_COLUMNS_HELP = "radar columns not found: run supabase/add_place_radar.sql first (Supabase SQL editor).";

function die(message: string): never {
  console.error(`[radar] ${message}`);
  process.exit(1);
}

async function fetchAllPlaces(): Promise<Place[]> {
  const rows = await restAll<Place & { place_photos?: { url: string; display_order: number }[] | null }>(
    `places?${SELECT}&${NOT_EVENT_VENUE}&order=id.asc`
  );
  return rows.map(withThumbnail);
}

/** Approved picks, in `list` order. Empty (with a hint) when the columns do not exist yet. */
async function fetchPicks(): Promise<Place[]> {
  try {
    const rows = await restAll<Place & { place_photos?: { url: string; display_order: number }[] | null }>(
      `places?${SELECT}&radar_picked_at=not.is.null&order=id.asc`
    );
    return orderPicks(rows.map(withThumbnail));
  } catch (err) {
    if (isMissingRadarColumn(asDbError(err))) {
      console.log(`(${MISSING_COLUMNS_HELP})`);
      return [];
    }
    throw err;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pickOne<T extends { id: string }>(arg: string | undefined, numbered: readonly T[], all: readonly T[], what: string): T {
  const token = (arg ?? "").trim();
  if (!token) die(`which ${what}? give a list number or a place id`);
  if (token.includes(",")) die("give exactly one number or id at a time");
  if (UUID_RE.test(token)) {
    return all.find((r) => r.id.toLowerCase() === token.toLowerCase()) ?? die(`no place with id ${token}`);
  }
  if (!/^\d+$/.test(token)) die(`"${token}" is neither a list number nor a place id`);
  return numbered[Number(token) - 1] ?? die(`no row numbered ${token} (the list has ${numbered.length})`);
}

function describe(place: Place): string {
  return `${place.name ?? "(no name)"} [${place.id}]`;
}

// --- commands ---------------------------------------------------------------

async function candidatesFor(limit: number) {
  const [places, picks] = await Promise.all([fetchAllPlaces(), fetchPicks()]);
  const excludedIds = new Set(picks.map((p) => p.id));
  return { places, candidates: selectCandidates(places, { limit, excludedIds }) };
}

async function cmdSuggest(limit: number, showIds: boolean) {
  const { places, candidates } = await candidatesFor(limit);
  console.log(`${places.length} places read -> ${candidates.length} candidate(s). Read-only: nothing saved.\n`);
  console.log(formatCandidateTable(candidates));
  if (showIds) {
    console.log("\nIds:");
    candidates.forEach((c, i) => console.log(`  ${i + 1}  ${c.place.id}`));
  }
  const weak = candidates.filter((c) => c.signal === "weak").length;
  if (weak) console.log(`\n${weak} row(s) marked WEAK: no usable rating/review count, so check them yourself before approving.`);
  console.log(`\nApprove with: approve <n> --why "one line"${limit === 20 ? "" : ` --limit=${limit}`}`);
}

async function cmdApprove(arg: string | undefined, why: string | undefined, limit: number, dryRun: boolean) {
  const line = (why ?? "").trim();
  if (!line) die('--why "one line" is required: the reason this place is worth knowing');
  if (line.length > RADAR_WHY_MAX_CHARS) console.warn(`[radar] warning: reason is ${line.length} chars (budget ${RADAR_WHY_MAX_CHARS}); stored as given.`);
  if (/hidden gem|FOMO\b/.test(line)) die('don\'t use "hidden gem" or "FOMO" in the reason');

  const { places, candidates } = await candidatesFor(limit);
  const place = pickOne(arg, candidates.map((c) => c.place), places, "place");
  if (place.radar_picked_at) die(`${describe(place)} is already a pick`);
  const patch = { radar_why: line, radar_picked_at: new Date().toISOString() };

  if (dryRun) return console.log(`DRY RUN, nothing written. Would approve ${describe(place)}:\n  ${line}`);
  await rest("PATCH", `places?id=eq.${place.id}`, patch, "return=minimal");
  console.log(`Approved ${describe(place)}:\n  ${line}`);
  console.log(`Feature it with: feature ${place.id}`);
}

async function cmdFeature(arg: string | undefined, week: string | undefined, dryRun: boolean) {
  const picks = await fetchPicks();
  const pick = pickOne(arg, picks, picks, "pick");
  if (!pick.radar_picked_at) die(`${describe(pick)} is not approved yet: run approve first`);
  if (week !== undefined && !isDayDate(week)) die("--week must be a date like 2026-11-16");
  const monday = week ? mondayOf(week) : currentWeekStart(new Date());
  if (week && monday !== week) console.log(`(${week} is not a Monday: using the week starting ${monday})`);
  const others = picks.filter((p) => p.radar_featured_week === monday && p.id !== pick.id);

  if (dryRun) {
    if (others.length) console.log(`DRY RUN. Would un-feature: ${others.map(describe).join(", ")}`);
    return console.log(`DRY RUN, nothing written. Would feature ${describe(pick)} for the week of ${monday}.`);
  }
  if (others.length) {
    await rest("PATCH", `places?radar_featured_week=eq.${monday}&id=neq.${pick.id}`, { radar_featured_week: null }, "return=minimal");
    console.log(`Un-featured for that week: ${others.map(describe).join(", ")}`);
  }
  await rest("PATCH", `places?id=eq.${pick.id}`, { radar_featured_week: monday }, "return=minimal");
  console.log(`Featured ${describe(pick)} for the week of ${monday}.`);
}

async function cmdList() {
  const picks = await fetchPicks();
  const thisWeek = currentWeekStart(new Date());
  console.log(`Under the radar: ${picks.length} pick(s). This week starts ${thisWeek}.\n`);
  if (picks.length === 0) return;
  picks.forEach((p, i) => {
    const flag = p.radar_featured_week ? `featured ${p.radar_featured_week}${p.radar_featured_week === thisWeek ? " (this week)" : ""}` : "";
    console.log(`  ${String(i + 1).padStart(2)}  ${(p.name ?? "").padEnd(34)} ${flag}`);
    console.log(`      ${p.radar_why}`);
  });
}

async function cmdRetire(arg: string | undefined, dryRun: boolean) {
  const picks = await fetchPicks();
  const pick = pickOne(arg, picks, picks, "pick");
  if (dryRun) return console.log(`DRY RUN, nothing written. Would retire ${describe(pick)}.`);
  await rest(
    "PATCH",
    `places?id=eq.${pick.id}`,
    { radar_why: null, radar_picked_at: null, radar_featured_week: null },
    "return=minimal"
  );
  console.log(`Retired ${describe(pick)}. It can be suggested again.`);
}

// --- main -------------------------------------------------------------------

const USAGE = `Usage: npx tsx --env-file=.env.local scripts/radar.ts <command> [options]

  suggest [--limit=20] [--ids]
  approve <n|id> --why "one line" [--limit=20] [--dry-run]   n = row of 'suggest' (same --limit)
  feature <n|id> [--week YYYY-MM-DD] [--dry-run]             n = row of 'list'
  list
  retire <n|id> [--dry-run]                                  n = row of 'list'`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      limit: { type: "string" },
      ids: { type: "boolean" },
      why: { type: "string" },
      week: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, arg] = positionals;
  if (!cmd || values.help) return console.log(USAGE);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    die("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (run with --env-file=.env.local).");
  }
  let limit = 20;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) die("--limit must be a positive whole number");
  }
  const dryRun = !!values["dry-run"];

  switch (cmd) {
    case "suggest":
      return cmdSuggest(limit, !!values.ids);
    case "approve":
      return cmdApprove(arg, values.why, limit, dryRun);
    case "feature":
      return cmdFeature(arg, values.week, dryRun);
    case "list":
      return cmdList();
    case "retire":
      return cmdRetire(arg, dryRun);
    default:
      console.error(`[radar] unknown command "${cmd}"\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((err) => {
  if (isMissingRadarColumn(asDbError(err))) die(MISSING_COLUMNS_HELP);
  console.error("[radar] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
