#!/usr/bin/env node
/**
 * tag-family.mjs — one-off backfill of `family_fit` ('kids' | 'all_ages' | null)
 * on existing events, happenings and places. See docs/plans/2026-10-20-families-lens.md.
 *
 *   events      upcoming only. classifyFamilyFit (scripts/sources/core/normalize.mjs,
 *               the same rules the daily import applies) on name + description.
 *   happenings  status = live. category/eligibility 'family' -> 'kids'; then the
 *               same keyword classifier on title + summary; then, with --ai, a
 *               DeepSeek pass on rows still undecided. happenings_staging is NOT
 *               touched.
 *   places      Edinburgh only. Category/name rules in scripts/lib/family-rules.mjs.
 *
 * Dry-run by default; --apply writes. Never overwrites a non-null family_fit
 * (so manual tags survive) unless --force. Never writes null. Needs the
 * `family_fit` column (supabase/add_family_fit.sql) and exits early if it is
 * missing, unless --preview (reads without the column, writes nothing).
 *
 * Uses the Supabase REST API directly (not supabase-js), same as
 * link-happening-places.mjs, with the service-role key.
 *
 * Usage:
 *   node --env-file=.env.local scripts/tag-family.mjs
 *   node --env-file=.env.local scripts/tag-family.mjs --table places
 *   node --env-file=.env.local scripts/tag-family.mjs --ai          (DeepSeek, off-peak only, $0.10 cap)
 *   node --env-file=.env.local scripts/tag-family.mjs --apply
 *   node --env-file=.env.local scripts/tag-family.mjs --preview     (no column needed, never writes)
 */

import { classifyFamilyFit } from "./sources/core/normalize.mjs";
import { happeningRulesFit, placeFamilyFit } from "./lib/family-rules.mjs";
import { callTool, createBudget } from "./sources/core/deepseek.mjs";

const TAG = "[tag-family]";
const TABLES = ["events", "happenings", "places"];

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node --env-file=.env.local scripts/tag-family.mjs [options]

Backfills family_fit ('kids' | 'all_ages') on events, happenings and places.
Dry-run by default. Never overwrites an existing family_fit unless --force.

Options:
  --apply              Write the proposed tags (default: print only).
  --table <name>       Only events | happenings | places.
  --ai                 Also classify still-undecided happenings with DeepSeek
                       (off-peak only; spend cap $0.10; batches of 25).
  --force              Also overwrite rows that already have a family_fit.
  --preview            Read rows WITHOUT the family_fit column, print proposals,
                       never write. For checking the rules before the SQL is run.
  --rows <n>           Rows shown in the review table (default 400).

Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (and
DEEPSEEK_API_KEY for --ai) in the env.
`);
  process.exit(0);
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const APPLY = flag("--apply");
const PREVIEW = flag("--preview");
const FORCE = flag("--force");
const USE_AI = flag("--ai");
const ROW_CAP = Number(argValue("--rows") ?? 400);
const onlyTable = argValue("--table");

if (onlyTable && !TABLES.includes(onlyTable)) {
  console.error(`${TAG} --table must be one of: ${TABLES.join(", ")}`);
  process.exit(1);
}
if (APPLY && PREVIEW) {
  console.error(`${TAG} --preview never writes; drop --apply (or drop --preview once the column exists).`);
  process.exit(1);
}

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!supabaseUrl || !serviceRoleKey) {
  console.error(`${TAG} Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Run with: node --env-file=.env.local scripts/tag-family.mjs`);
  process.exit(1);
}

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

class RestError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} → ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

async function rest(path, options = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  if (!res.ok) throw new RestError(options.method ?? "GET", path, res.status, await res.text());
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

/** True when the table has no family_fit column yet (42703 / PGRST204 / "does not exist"). */
async function columnMissing(table) {
  try {
    await rest(`${table}?select=family_fit&limit=1`);
    return false;
  } catch (err) {
    if (!(err instanceof RestError)) throw err;
    if (/42703|PGRST204|does not exist|could not find/i.test(err.body)) return true;
    throw err;
  }
}

const ff = (extra) => (PREVIEW ? "" : `,family_fit${extra ?? ""}`);
const EDINBURGH_BBOX = { latMin: 55.85, latMax: 56.0, lngMin: -3.45, lngMax: -3.0 };
const inEdinburghBbox = (r) =>
  r.lat == null || r.lng == null || (r.lat >= EDINBURGH_BBOX.latMin && r.lat <= EDINBURGH_BBOX.latMax && r.lng >= EDINBURGH_BBOX.lngMin && r.lng <= EDINBURGH_BBOX.lngMax);

// A proposal: { table, id, title, category, value, reason, quote? }. Rows that
// already have a family_fit are skipped (counted) unless --force.
const proposals = [];
const skippedExisting = { events: 0, happenings: 0, places: 0 };
const scanned = { events: 0, happenings: 0, places: 0 };

function propose(table, row, title, decision) {
  if (!decision.value) return;
  if (!PREVIEW && row.family_fit != null && !FORCE) {
    skippedExisting[table] += 1;
    return;
  }
  if (!PREVIEW && row.family_fit === decision.value) return;
  proposals.push({ table, id: row.id, title, category: row.category ?? null, value: decision.value, reason: decision.reason, quote: decision.quote ?? null });
}

// --- events -------------------------------------------------------------------

async function scanEvents() {
  const nowIso = new Date().toISOString();
  const rows = await fetchAllPages(`events?starts_at=gte.${encodeURIComponent(nowIso)}&order=starts_at.asc&select=id,name,description,category,venue_name${ff()}`);
  scanned.events = rows.length;
  for (const r of rows) {
    const value = classifyFamilyFit({ name: r.name, description: r.description, category: r.category, venueName: r.venue_name });
    propose("events", r, r.name, { value, reason: "keyword" });
  }
}

// --- happenings ---------------------------------------------------------------

const AI_BATCH = 25;
const FAMILY_TOOL = {
  name: "submit_family_fit",
  description: "Submit a family_fit decision for every listing id given.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            family_fit: { type: ["string", "null"], enum: ["kids", "all_ages", null] },
            quote: { type: ["string", "null"], description: "Exact words copied from the listing that support kids/all_ages; null when family_fit is null." },
          },
          required: ["id", "family_fit", "quote"],
        },
      },
    },
    required: ["items"],
  },
};
const AI_SYSTEM = `You classify Edinburgh (Scotland) listings for parents looking for things to do with children aged 0-12.
Be STRICT. Most listings are null. For each listing choose family_fit:
- "kids": the listing itself is aimed at children (kids' shows, toddler or baby sessions, family workshops, children's trails, "kids eat free", soft play). The listing must say so, or be unmistakably a children's activity.
- "all_ages": NOT aimed at children, but clearly a place or activity a parent would take young children to: a free museum or gallery, botanic gardens, a park, a parkrun, Christmas lights, a zoo or family attraction.
- null: everything else. In particular null for: pubs, bars, nightlife, adult classes, concerts and gigs, sports fixtures and season tickets, ticket price lists, resident/student/over-60/Young Scot discounts and passes, transport passes, schemes for teenagers or "young people" aged 8-18, markets, walking and bus tours, festivals and conferences unless the listing says children or families are welcome, and anything unclear. When in doubt, null.
For "kids" and "all_ages" you MUST give a quote: words copied exactly from the listing that support the call (for all_ages, the words that show it suits young children, e.g. "free entry" at a museum). A listing that only mentions an under-12s or under-18s ticket price is null. Return one item per listing id.`;

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

async function aiClassify(rows) {
  const budget = createBudget(0.1);
  const out = new Map();
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (let i = 0; i < rows.length; i += AI_BATCH) {
    const batch = rows.slice(i, i + AI_BATCH);
    const user = batch
      .map((r) => JSON.stringify({ id: String(r.id), title: r.title, summary: String(r.summary ?? "").slice(0, 400), category: r.category ?? null, venue: r.venue_name ?? null }))
      .join("\n");
    const res = await callTool({ system: AI_SYSTEM, user: `Listings (one JSON object per line):\n${user}`, tool: FAMILY_TOOL, maxTokens: 3000, budget });
    if (!res.ok) {
      if (res.reason === "deepseek_peak_hours") {
        console.log(`${TAG} DeepSeek refused: deepseek_peak_hours (01-04 / 06-10 UTC Mon-Fri). Continuing with rules-only results for the rest.`);
        break;
      }
      console.log(`${TAG} DeepSeek batch ${i / AI_BATCH + 1} failed: ${res.reason}`);
      if (res.reason === "budget_exhausted" || res.reason === "no_api_key") break;
      continue;
    }
    for (const item of Array.isArray(res.input.items) ? res.input.items : []) {
      const row = byId.get(String(item?.id));
      if (!row || (item.family_fit !== "kids" && item.family_fit !== "all_ages")) continue;
      const quote = String(item.quote ?? "").trim();
      const text = norm(`${row.title} ${row.summary ?? ""} ${row.venue_name ?? ""}`);
      if (!quote || !text.includes(norm(quote))) continue; // unsupported call: drop it
      out.set(String(row.id), { value: item.family_fit, reason: "ai", quote });
    }
  }
  console.log(`${TAG} DeepSeek: ${budget.calls} call(s), ~$${budget.spentUsd.toFixed(4)} of $${budget.maxUsd.toFixed(2)}, ${out.size} supported tag(s).`);
  return out;
}

async function scanHappenings() {
  const rows = await fetchAllPages(`happenings?status=eq.live&order=slug.asc&select=id,title,summary,category,eligibility,venue_name${ff()}`);
  scanned.happenings = rows.length;
  const undecided = [];
  for (const r of rows) {
    const decision = happeningRulesFit(r);
    if (decision.value) propose("happenings", r, r.title, decision);
    else if (PREVIEW || r.family_fit == null || FORCE) undecided.push(r);
  }
  if (USE_AI && undecided.length > 0) {
    console.log(`${TAG} --ai: ${undecided.length} undecided happening(s) -> DeepSeek in batches of ${AI_BATCH}`);
    const decisions = await aiClassify(undecided);
    for (const r of undecided) {
      const d = decisions.get(String(r.id));
      if (d) propose("happenings", r, r.title, d);
    }
  } else if (USE_AI) {
    console.log(`${TAG} --ai: no undecided happenings.`);
  }
}

// --- places -------------------------------------------------------------------

async function scanPlaces() {
  const rows = (
    await fetchAllPages(
      `places?source=neq.google&or=(city.ilike.*Edinburgh*,destination.ilike.*Edinburgh*,address.ilike.*Edinburgh*)&order=name.asc&select=id,name,category,lat,lng${ff()}`
    )
  ).filter(inEdinburghBbox);
  scanned.places = rows.length;
  for (const r of rows) propose("places", r, r.name, placeFamilyFit(r));
}

// --- output -------------------------------------------------------------------

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const pad = (s, n) => clip(s, n).padEnd(n);

function printSummary(tables) {
  console.log(`\n${TAG} SUMMARY${PREVIEW ? " (preview: existing values ignored)" : ""}`);
  console.log(`${pad("table", 11)}${pad("scanned", 9)}${pad("kids", 7)}${pad("all_ages", 10)}${pad("skipped(existing)", 18)}`);
  for (const t of tables) {
    const mine = proposals.filter((p) => p.table === t);
    const n = (v) => mine.filter((p) => p.value === v).length;
    console.log(`${pad(t, 11)}${pad(scanned[t], 9)}${pad(n("kids"), 7)}${pad(n("all_ages"), 10)}${pad(PREVIEW ? "-" : skippedExisting[t], 18)}`);
  }
  const bySource = {};
  for (const p of proposals) bySource[`${p.table}:${p.reason.split(":")[0]}`] = (bySource[`${p.table}:${p.reason.split(":")[0]}`] ?? 0) + 1;
  console.log(`by rule: ${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join("  ") || "(none)"}`);
}

function printReview() {
  if (proposals.length === 0) return;
  console.log(`\n${TAG} PROPOSED CHANGES (${proposals.length}${proposals.length > ROW_CAP ? `, showing first ${ROW_CAP}; --rows N for more` : ""})`);
  console.log(`${pad("table", 11)}${pad("id", 9)}${pad("title", 52)}${pad("category", 14)}${pad("value", 9)}reason`);
  for (const p of proposals.slice(0, ROW_CAP)) {
    const reason = p.quote ? `${p.reason} "${clip(p.quote, 40)}"` : p.reason;
    console.log(`${pad(p.table, 11)}${pad(p.id, 9)}${pad(p.title, 52)}${pad(p.category, 14)}${pad(p.value, 9)}${clip(reason, 60)}`);
  }
}

async function applyProposals() {
  const written = {};
  for (const table of TABLES) {
    for (const value of ["kids", "all_ages"]) {
      const ids = proposals.filter((p) => p.table === table && p.value === value).map((p) => p.id);
      let ok = 0;
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        // family_fit=is.null in the filter: never clobber a tag set between the read and this write (unless --force).
        const guard = FORCE ? "" : "&family_fit=is.null";
        try {
          const res = await rest(`${table}?id=in.(${chunk.map((id) => encodeURIComponent(id)).join(",")})${guard}&select=id`, {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({ family_fit: value }),
          });
          ok += res?.length ?? 0;
        } catch (err) {
          console.error(`${TAG} FAILED ${table} ${value} batch of ${chunk.length}: ${err.message}`);
        }
      }
      if (ids.length > 0) written[`${table}.${value}`] = `${ok}/${ids.length}`;
    }
  }
  console.log(`\n${TAG} WRITTEN (written/proposed): ${Object.entries(written).map(([k, v]) => `${k}=${v}`).join("  ") || "nothing"}`);
}

async function main() {
  const tables = onlyTable ? [onlyTable] : TABLES;
  console.log(`${TAG} ${PREVIEW ? "PREVIEW (no column needed, never writes)" : APPLY ? "APPLY" : "DRY RUN"} tables=${tables.join(",")}${FORCE ? " --force" : ""}${USE_AI ? " --ai" : ""}`);

  if (!PREVIEW) {
    const missing = [];
    for (const t of tables) if (await columnMissing(t)) missing.push(t);
    if (missing.length > 0) {
      console.error(`${TAG} family_fit column missing on: ${missing.join(", ")} — run supabase/add_family_fit.sql first (Supabase SQL editor), then re-run. (Use --preview to test the rules without the column.)`);
      process.exit(1);
    }
  }

  if (tables.includes("events")) await scanEvents();
  if (tables.includes("happenings")) await scanHappenings();
  if (tables.includes("places")) await scanPlaces();

  printSummary(tables);
  printReview();

  if (PREVIEW || !APPLY) {
    console.log(`\n${TAG} ${PREVIEW ? "PREVIEW" : "DRY RUN"} — ${PREVIEW ? "nothing is ever written in preview mode." : "pass --apply to write. Nothing written."}`);
    return;
  }
  if (proposals.length === 0) {
    console.log(`\n${TAG} nothing to write.`);
    return;
  }
  await applyProposals();
}

main().catch((err) => {
  console.error(`${TAG} fatal:`, err);
  process.exit(1);
});
