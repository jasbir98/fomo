#!/usr/bin/env -S npx tsx
/**
 * scripts/finds.ts — curate the Finds list ("Fomo Finds" on Instagram, "For
 * you" in the app): suggest candidates, approve the ones worth showing, edit
 * their copy, retire them. Nothing goes live without `approve`.
 *
 *   npx tsx --env-file=.env.local scripts/finds.ts <command> [options]
 *
 *   suggest [--dry-run] [--days=10] [--limit=12] [--no-ai]
 *   list [--suggested|--live]          (no flag: both)
 *   approve <n,...>                    -> status live
 *   edit <n> [--why "..."] [--level 4]
 *   retire <n,...>                     -> status retired (never re-suggested)
 *   clear-suggested                    -> delete every `suggested` row
 *
 * NUMBERS. A number is a row position in `list --suggested` (score desc). That
 * is what `suggest` prints and what approve/edit/retire resolve, always
 * re-derived from the DB (lib/finds/curation.ts). Add `--live` to edit/retire
 * to number the live list (`list --live`) instead. A row uuid works anywhere.
 *
 * WHY TS. Run through tsx so it can import lib/happenings/hero.ts (the Home
 * hero's scoring), occurrence.ts and the Finds pure modules directly instead
 * of porting them again; `@/` imports resolve via tsconfig paths. Needs
 * `.env.local` for NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * (and DEEPSEEK_API_KEY for the AI step).
 *
 * DB ACCESS. Plain `fetch` against `${NEXT_PUBLIC_SUPABASE_URL}/rest/v1` with
 * the service-role key, NOT @supabase/supabase-js, whose mandatory Realtime/
 * WebSocket init throws under plain Node 20. Same house pattern as
 * scripts/lib/weekly-picks.mjs. The service role is what bypasses the
 * read-only RLS on `finds` (supabase/add_finds.sql).
 *
 * SUGGEST, in order:
 *   1. Retire live Finds whose subject has ended / gone dormant / been
 *      cancelled (the same lib/finds/build.ts `findIsStale` that hides them
 *      from the app), and delete suggested drafts whose subject has ended.
 *   2. Candidates: lib/finds/candidates.ts — live happenings with an
 *      occurrence in the next N days, evergreen genuine deals, and free/<=£15
 *      events in the next N days; family-only and over-60-only dropped;
 *      subjects already live or retired are never re-suggested.
 *   3. Score with hero.ts, take the top `--limit` with at most about half
 *      events.
 *   4. One batched DeepSeek call drafts each `why` (<= 90 chars) and 1-5 Fomo
 *      level, via scripts/sources/core/deepseek.mjs, which refuses in
 *      DeepSeek's peak hours and enforces a spend cap (both respected, never
 *      bypassed). If that is off or fails for any reason (`--no-ai`, peak
 *      hours, no key, bad output) each candidate falls back to the hero
 *      reason + venue and a level derived from its score. Never fails the run.
 *   5. Upsert as `suggested` with week_of = the coming Friday (Europe/London),
 *      then print the numbered table. `--dry-run` writes nothing (including
 *      step 1) and prints the table the run would have produced.
 */
import { parseArgs } from "node:util";
import { callTool, createBudget } from "./sources/core/deepseek.mjs";
import { findIsStale } from "@/lib/finds/build";
import {
  comingFriday,
  describeSubject,
  fallbackWhy,
  heroScorers,
  levelFromScore,
  parseAiDrafts,
  selectCandidates,
  toSuggestionRow,
  WHY_MAX_CHARS,
  type Draft,
  type FindCandidate,
} from "@/lib/finds/candidates";
import {
  formatTable,
  lineFromCandidate,
  liveOrder,
  resolveTargets,
  suggestedOrder,
  type TableLine,
} from "@/lib/finds/curation";
import { findKey, type FindRow } from "@/lib/finds/types";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";

// --- Supabase REST ---------------------------------------------------------

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

/** True when PostgREST says `finds` doesn't exist (PGRST205 schema-cache miss, or Postgres 42P01). */
function isMissingFindsTable(err: unknown): boolean {
  return err instanceof RestError && /PGRST205|42P01/.test(err.body) && /finds/.test(err.body);
}

async function rest<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  prefer?: string
): Promise<T> {
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

/** GET every row, paging past PostgREST's 1000-row cap. `path` must already carry a stable `order`. */
async function restAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await rest<T[]>("GET", `${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${offset}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

const inList = (ids: string[]) => `in.(${ids.join(",")})`;

async function fetchFinds(): Promise<FindRow[]> {
  return restAll<FindRow>("finds?select=*&order=id.asc");
}

async function fetchSubjects(rows: readonly FindRow[]) {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.subject_type === type).map((r) => r.subject_id))];
  const get = async <T extends { id: string }>(table: string, list: string[]) =>
    new Map((list.length ? await restAll<T>(`${table}?select=*&id=${inList(list)}&order=id.asc`) : []).map((x) => [x.id, x]));
  const [events, happenings] = await Promise.all([
    get<EventItem>("events", ids("event")),
    get<Happening>("happenings", ids("happening")),
  ]);
  return { events, happenings };
}

// --- helpers ---------------------------------------------------------------

function die(message: string): never {
  console.error(`[finds] ${message}`);
  process.exit(1);
}

const MISSING_TABLE_HELP = "finds table not found: run supabase/add_finds.sql first (Supabase SQL editor).";

function subjectOf(
  row: FindRow,
  subjects: Awaited<ReturnType<typeof fetchSubjects>>
): Happening | EventItem | undefined {
  return row.subject_type === "event" ? subjects.events.get(row.subject_id) : subjects.happenings.get(row.subject_id);
}

function lineFromRow(row: FindRow, subjects: Awaited<ReturnType<typeof fetchSubjects>>, now: Date): TableLine {
  const subject = subjectOf(row, subjects);
  const d = subject
    ? describeSubject(row.subject_type, subject, now)
    : { title: "(subject missing)", when: "", price: "" };
  return { type: row.subject_type, ...d, score: row.score, level: row.fomo_level, why: row.why };
}

async function printList(rows: FindRow[], heading: string, now: Date) {
  console.log(`\n${heading}`);
  if (rows.length === 0) return console.log("  (none)");
  const subjects = await fetchSubjects(rows);
  console.log(formatTable(rows.map((r) => lineFromRow(r, subjects, now))));
}

// --- AI drafts -------------------------------------------------------------

const DRAFT_TOOL = {
  name: "submit_finds",
  description: "Submit the one-line reason and Fomo level for each numbered candidate.",
  input_schema: {
    type: "object",
    properties: {
      finds: {
        type: "array",
        items: {
          type: "object",
          properties: {
            n: { type: "integer", description: "The candidate's number, as given." },
            why: { type: "string", description: `Why it's a steal, at most ${WHY_MAX_CHARS} characters.` },
            fomo_level: { type: "integer", description: "1 to 5." },
          },
          required: ["n", "why", "fomo_level"],
        },
      },
    },
    required: ["finds"],
  },
};

const DRAFT_SYSTEM = `You write the one-line "why it's a steal" for Fomo, an Edinburgh app for free and cheap things to do and student/local deals. Audience: students and young professionals.

For each numbered candidate return:
- why: at most ${WHY_MAX_CHARS} characters. Punchy and concrete, built on the numbers and facts given. Example: "£8 wristband gets you £5 cocktails all week". Do not repeat the title. No hype words, no emoji, no exclamation marks, UK English.
- fomo_level: 1-5, how much someone would regret missing it. 5 = rare, big saving or free and unmissable this week; 3 = genuinely good value; 1 = fine but ordinary.

Use ONLY the facts provided. Never invent a price, date, venue or saving. If the facts don't state a number, describe the value without one.`;

/** Returns drafts by candidate index plus a note for the log; never throws. */
async function aiDrafts(
  candidates: FindCandidate[]
): Promise<{ drafts: Map<number, Draft>; note: string }> {
  if (candidates.length === 0) return { drafts: new Map(), note: "no candidates" };
  const user = candidates
    .map((c, i) =>
      JSON.stringify({
        n: i + 1,
        type: c.subject_type,
        title: c.title,
        venue: c.venue,
        when: c.when,
        price: c.price || null,
        facts: c.detail || null,
      })
    )
    .join("\n");
  const budget = createBudget();
  try {
    const res = await callTool({
      system: DRAFT_SYSTEM,
      user: `Candidates, one JSON object per line:\n${user}`,
      tool: DRAFT_TOOL,
      maxTokens: 2500,
      budget,
    });
    if (!res.ok) return { drafts: new Map(), note: `AI skipped (${res.reason})` };
    const drafts = parseAiDrafts(res.input, candidates.length);
    return { drafts, note: `AI drafted ${drafts.size}/${candidates.length} ($${budget.spentUsd.toFixed(4)})` };
  } catch (err) {
    return { drafts: new Map(), note: `AI failed (${err instanceof Error ? err.message : String(err)})` };
  }
}

// --- commands ---------------------------------------------------------------

async function cmdSuggest(opts: { dryRun: boolean; days: number; limit: number; noAi: boolean }) {
  const now = new Date();
  const all = await fetchFinds();

  // 1. Housekeeping: live Finds whose subject ended -> retired; ended drafts -> deleted.
  const open = all.filter((r) => r.status === "live" || r.status === "suggested");
  const heldSubjects = await fetchSubjects(open);
  const stale = open.filter((r) => findIsStale(r, subjectOf(r, heldSubjects), now));
  const retire = stale.filter((r) => r.status === "live");
  const dropDrafts = stale.filter((r) => r.status === "suggested");
  if (retire.length) {
    if (!opts.dryRun) await rest("PATCH", `finds?id=${inList(retire.map((r) => r.id))}`, { status: "retired" });
    console.log(`${opts.dryRun ? "Would retire" : "Retired"} ${retire.length} ended live Find(s): ${retire.map((r) => r.why).join(" | ")}`);
  }
  if (dropDrafts.length) {
    if (!opts.dryRun) await rest("DELETE", `finds?id=${inList(dropDrafts.map((r) => r.id))}`);
    console.log(`${opts.dryRun ? "Would drop" : "Dropped"} ${dropDrafts.length} suggested draft(s) whose subject has ended.`);
  }

  // 2. Candidates. Live/retired subjects (including ones just retired) are never re-suggested.
  const excluded = new Set(
    all.filter((r) => r.status === "live" || r.status === "retired").map((r) => findKey(r.subject_type, r.subject_id))
  );
  const horizon = new Date(now.getTime() + opts.days * 86_400_000).toISOString();
  const [happenings, events] = await Promise.all([
    restAll<Happening>("happenings?status=eq.live&select=*&order=id.asc"),
    restAll<EventItem>(
      `events?starts_at=gte.${encodeURIComponent(now.toISOString())}&starts_at=lte.${encodeURIComponent(horizon)}` +
        `&or=(city.ilike.%25Edinburgh%25,destination.ilike.%25Edinburgh%25,address.ilike.%25Edinburgh%25)` +
        `&select=*&order=starts_at.asc,id.asc`
    ),
  ]);
  const picked = selectCandidates({ happenings, events, now, days: opts.days, limit: opts.limit, excluded, scorers: heroScorers });
  console.log(`${happenings.length} live happenings + ${events.length} events in ${opts.days}d -> ${picked.length} candidate(s).`);
  if (picked.length === 0) return;

  // 3. Copy: AI when allowed, else (or per-candidate on a miss) the template.
  let ai: Awaited<ReturnType<typeof aiDrafts>> = { drafts: new Map(), note: "AI off (--no-ai)" };
  if (!opts.noAi) ai = await aiDrafts(picked);
  console.log(ai.note);
  const drafts: Draft[] = picked.map(
    (c, i) =>
      ai.drafts.get(i) ?? { why: fallbackWhy(c), fomo_level: levelFromScore(c.score) }
  );

  // 4. Upsert, then print. Real runs print what is now in the DB so the
  // numbers shown are exactly the `list --suggested` / `approve` numbers.
  const weekOf = comingFriday(now);
  if (opts.dryRun) {
    console.log(`\nDRY RUN, nothing saved. Week of ${weekOf}. Numbers below are only indicative.\n`);
    console.log(formatTable(picked.map((c, i) => lineFromCandidate(c, drafts[i].fomo_level, drafts[i].why))));
    return;
  }
  await rest(
    "POST",
    "finds?on_conflict=subject_type,subject_id",
    picked.map((c, i) => toSuggestionRow(c, drafts[i], weekOf)),
    "resolution=merge-duplicates,return=minimal"
  );
  console.log(`\nSaved ${picked.length} suggestion(s) for the week of ${weekOf}.`);
  await printList(suggestedOrder(await fetchFinds()), "Suggested (approve with: approve 1,3):", now);
}

async function cmdList(which: "suggested" | "live" | "both") {
  const now = new Date();
  const rows = await fetchFinds();
  if (which !== "live") await printList(suggestedOrder(rows), "Suggested (approve / edit / retire use these numbers):", now);
  if (which !== "suggested") await printList(liveOrder(rows), "Live (edit / retire with --live use these numbers):", now);
}

function targets(arg: string | undefined, rows: FindRow[], live: boolean): FindRow[] {
  if (!arg) die("which rows? give list numbers (1,3) or row ids");
  const res = resolveTargets(arg, live ? liveOrder(rows) : suggestedOrder(rows), rows);
  if (!res.ok) die(res.error);
  return res.rows;
}

async function cmdApprove(arg: string | undefined) {
  const rows = await fetchFinds();
  const picked = targets(arg, rows, false);
  const already = picked.filter((r) => r.status === "live");
  if (already.length) console.log(`Already live, skipped: ${already.map((r) => r.id).join(", ")}`);
  const todo = picked.filter((r) => r.status !== "live");
  if (todo.length === 0) return;
  await rest("PATCH", `finds?id=${inList(todo.map((r) => r.id))}`, { status: "live", approved_at: new Date().toISOString() });
  console.log(`Approved ${todo.length}: now live.`);
  await cmdList("live");
}

async function cmdEdit(arg: string | undefined, why: string | undefined, level: string | undefined, live: boolean) {
  const rows = await fetchFinds();
  const picked = targets(arg, rows, live);
  if (picked.length !== 1) die("edit takes exactly one row");
  const patch: { why?: string; fomo_level?: number } = {};
  if (why !== undefined) {
    if (!why.trim()) die("--why can't be empty");
    if (why.length > WHY_MAX_CHARS) console.warn(`[finds] warning: why is ${why.length} chars (budget ${WHY_MAX_CHARS}); stored as given.`);
    patch.why = why.trim();
  }
  if (level !== undefined) {
    const n = Number(level);
    if (!Number.isInteger(n) || n < 1 || n > 5) die("--level must be a whole number 1-5");
    patch.fomo_level = n;
  }
  if (Object.keys(patch).length === 0) die("nothing to change: pass --why and/or --level");
  await rest("PATCH", `finds?id=eq.${picked[0].id}`, patch);
  console.log(`Updated ${picked[0].id}: ${JSON.stringify(patch)}`);
}

async function cmdRetire(arg: string | undefined, live: boolean) {
  const rows = await fetchFinds();
  const picked = targets(arg, rows, live);
  await rest("PATCH", `finds?id=${inList(picked.map((r) => r.id))}`, { status: "retired" });
  console.log(`Retired ${picked.length} (kept in the table so they aren't suggested again).`);
}

async function cmdClearSuggested() {
  const gone = await rest<FindRow[]>("DELETE", "finds?status=eq.suggested", undefined, "return=representation");
  console.log(`Deleted ${gone.length} suggested row(s). Live and retired rows untouched.`);
}

// --- main -------------------------------------------------------------------

const USAGE = `Usage: npx tsx --env-file=.env.local scripts/finds.ts <command> [options]

  suggest [--dry-run] [--days=10] [--limit=12] [--no-ai]
  list [--suggested|--live]
  approve <n,...>                 numbers from 'list --suggested', or row ids
  edit <n> [--why "..."] [--level 4] [--live]
  retire <n,...> [--live]         --live: numbers from 'list --live'
  clear-suggested`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      days: { type: "string" },
      limit: { type: "string" },
      "no-ai": { type: "boolean" },
      suggested: { type: "boolean" },
      live: { type: "boolean" },
      why: { type: "string" },
      level: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, arg] = positionals;
  if (!cmd || values.help) return console.log(USAGE);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    die("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (run with --env-file=.env.local).");
  }
  const posInt = (raw: string | undefined, fallback: number, name: string) => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) die(`--${name} must be a positive whole number`);
    return n;
  };

  switch (cmd) {
    case "suggest":
      return cmdSuggest({
        dryRun: !!values["dry-run"],
        days: posInt(values.days, 10, "days"),
        limit: posInt(values.limit, 12, "limit"),
        noAi: !!values["no-ai"],
      });
    case "list":
      return cmdList(values.live && !values.suggested ? "live" : values.suggested && !values.live ? "suggested" : "both");
    case "approve":
      return cmdApprove(arg);
    case "edit":
      return cmdEdit(arg, values.why, values.level, !!values.live);
    case "retire":
      return cmdRetire(arg, !!values.live);
    case "clear-suggested":
      return cmdClearSuggested();
    default:
      console.error(`[finds] unknown command "${cmd}"\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((err) => {
  if (isMissingFindsTable(err)) die(MISSING_TABLE_HELP);
  console.error("[finds] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
