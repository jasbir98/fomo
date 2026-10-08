#!/usr/bin/env node
/**
 * daily-sources.mjs — Tier-1 daily events ingest for Fomo (Edinburgh).
 *
 * This is the only writer to the `events` table. The app (lib/events/) reads
 * from it; nothing in the request path fetches Skiddle/Ticketmaster live and
 * caches. Coverage is whatever this script ingests, so it's the proactive
 * crawl: it fetches free, public sources that embed schema.org Event JSON-LD
 * on their Edinburgh listing pages (no paid API, no login, no scraping
 * framework — same fetch+parse-JSON-LD approach as scraper/weekly_edinburgh.py's
 * `direct_records()`, reimplemented in JS so it runs in GitHub Actions on
 * plain Node), plus a paginated lookahead pull of the Skiddle and Ticketmaster
 * APIs (when SKIDDLE_API_KEY / TICKETMASTER_API_KEY are set), and upserts
 * normalized rows into `events` via PostgREST, keyed on
 * (provider, provider_event_id) — the unique index every provider shares, so
 * re-discovering an event updates its row rather than duplicating it. Rows for
 * the same real event from different providers are collapsed by this script's
 * own cross-source dedupe (core/dedupe.mjs) before anything is upserted, and
 * again at read time (lib/happenings/merge-events.ts's `dedupeProviderEvents`).
 *
 * LAYOUT. This file is orchestration only: CLI parsing, running the adapters,
 * cross-source dedupe, description backfill, upsert, exit codes.
 *   scripts/sources/registry.mjs   ordered adapter list (run order)
 *   scripts/sources/adapters/*.mjs one adapter per source:
 *                                  { name, cadence, status, run(ctx) }
 *   scripts/sources/core/*.mjs     shared pieces: fetch (robots + politeness),
 *                                  jsonld, normalize, dedupe, upsert, backfill,
 *                                  summary, config
 *
 * SOURCES:
 *   luma         https://lu.ma/edinburgh                                    (~20 events; tech/startup/networking; free, public, JSON-LD)
 *   eventbrite   https://www.eventbrite.co.uk/d/united-kingdom--edinburgh/...  (discover pages, 20/page; free, public, JSON-LD)
 *   songkick     https://www.songkick.com/metro-areas/24551-uk-edinburgh    (gigs; NOT 24542, that's Birmingham; free, public, JSON-LD)
 *   allevents    https://allevents.in/edinburgh/all                         (leaks non-Edinburgh rows — geo-filtered; free, public, JSON-LD)
 *   skiddle      Skiddle Events API, /events/search/ (needs SKIDDLE_API_KEY)
 *   ticketmaster Ticketmaster Discovery v2, /events.json (needs TICKETMASTER_API_KEY)
 *   sneakypetes  https://sneakypetes.co.uk/feed                             (venue RSS feed — see adapters/venue-rss.mjs for the many venues checked and rejected: no structured data, blocked, or robots-disallowed)
 *
 * ADAPTER FLAGS. `status: "shadow"` adapters run and are reported (labelled
 * `[shadow]`) but their rows are never deduped or upserted. `cadence: "weekly"`
 * adapters only run on Mondays (Europe/London), when named in --only, or with
 * --all-cadences. Nothing uses either yet.
 *
 * Every row (from any source) also gets: an "off-wedge" filter (drops
 * multi-day/excursion-style listings that don't fit Edinburgh students/young
 * professionals looking for tonight/this weekend — see isOffWedge in
 * core/normalize.mjs) and a keyword-based category fallback for rows a
 * source's own type/segment/eventcode mapping left as "other" (see
 * classifyCategory).
 *
 * POLITENESS. Applies to the HTML/RSS-scraped sources only — Skiddle/Ticketmaster
 * are authenticated API calls, not page scrapes, so robots.txt doesn't apply
 * to them; they're still one sequential request at a time, wrapped in the
 * same try/catch-per-page safety and paginated with a hard page cap (never an
 * unbounded loop). For the scraped sources (core/fetch.mjs):
 * robots.txt is fetched and evaluated once per hostname per run
 * (cached) before any page on that host is requested — group selection by
 * product-token match (falling back to `*`), longest-path Allow/Disallow
 * with `*`/`$` wildcards, and Crawl-delay (raises the per-host interval when
 * it asks for slower than our default). A disallowed URL is skipped and
 * logged as "robots_disallowed" — never fetched, never worked around. Unlike
 * scraper/weekly_edinburgh.py's robot_allows() (which fails OPEN on a
 * robots.txt fetch error, being a supervised, occasional run), this script
 * fails CLOSED: only a clean 404 means "no rules"; any other error/timeout
 * skips that whole host for the run ("robots_unavailable"). On top of that:
 * real, identifying User-Agent; ~1 request/sec per hostname; a 20s timeout
 * per request; every adapter and every individual page fetch is wrapped in
 * its own try/catch so one dead source/page never kills the run. A
 * 401/403/429/503 or a detected bot-challenge page is likewise treated as
 * "this source said no" and skipped outright — never retried.
 *
 * SAFETY. --dry-run is the default (matches scripts/sweep-happenings.mjs's
 * convention): prints per-source fetched/parsed/kept/skipped counts and 3
 * sample normalized rows per source, writes nothing. Pass --write to
 * actually upsert. Never deletes anything.
 *
 * Uses the Supabase REST API directly (not @supabase/supabase-js) — that
 * client's mandatory Realtime/WebSocket init throws under plain Node 20,
 * same reasoning as scripts/promote-places.mjs and
 * scripts/sweep-happenings.mjs.
 *
 * DESCRIPTIONS. Every row's description is cleaned by
 * scripts/lib/describe.mjs's cleanDescription() (strips HTML/URLs/emoji,
 * drops ticket-sale/legal boilerplate, trims to ~1-2 sentences). Whatever's
 * still empty/short after that goes through a backfill phase
 * (backfillDescriptions(), after cross-source merge, before upsert): fetches
 * the row's own ticket_url through the same politeFetch() as the JSON-LD
 * adapters and reads JSON-LD description -> og:description -> meta
 * description, capped at 150 fetches/run. Still-empty rows get a
 * last-resort factual fallbackDescription() built only from fields already
 * on the row. See docs/daily-sources.md's "Descriptions" section.
 *
 * Usage:
 *   node --env-file=.env.local scripts/daily-sources.mjs                # dry run, all sources
 *   node --env-file=.env.local scripts/daily-sources.mjs --write        # actually upsert
 *   node --env-file=.env.local scripts/daily-sources.mjs --only=luma,songkick
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to
 * --write (server-only — never NEXT_PUBLIC_ for the key itself). Dry runs
 * work without them; a warning is printed instead of failing, since a dry
 * run's whole point is to be inspectable without touching the DB.
 * Optional SKIDDLE_API_KEY / TICKETMASTER_API_KEY enable the two API
 * adapters; each is skipped with a log line (not a failure) when its key is
 * absent, in both dry-run and --write.
 */

import { ADAPTERS } from "./sources/registry.mjs";
import { SUPABASE_URL, SERVICE_ROLE_KEY } from "./sources/core/config.mjs";
import { dedupeAcrossSources } from "./sources/core/dedupe.mjs";
import { backfillDescriptions } from "./sources/core/backfill.mjs";
import { upsertEvents } from "./sources/core/upsert.mjs";
import { emptyStats } from "./sources/core/stats.mjs";
import { printSummary, printDedupeSummary, printCategorySummary, printBackfillSummary } from "./sources/core/summary.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node --env-file=.env.local scripts/daily-sources.mjs [options]

Crawls lu.ma, Eventbrite, Songkick and allevents.in's Edinburgh listing pages
for schema.org Event JSON-LD, plus (when SKIDDLE_API_KEY / TICKETMASTER_API_KEY
are set) a proactive paginated pull of the Skiddle and Ticketmaster APIs, and
upserts normalized rows into \`events\`, deduped on (provider, provider_event_id).

Options:
  --dry-run       Print per-source counts + 3 sample rows, write nothing.
                   Default behavior when neither --dry-run nor --write is given.
  --write         Actually upsert into \`events\`.
  --only=a,b      Only run the named adapters (${ADAPTERS.map((a) => a.name).join(", ")}).
  --skip=a,b      Skip the named adapters (same as DAILY_SOURCES_SKIP env var, comma-separated).
                   Eventbrite has been seen returning HTTP 405 to some datacenter IPs (e.g.
                   GitHub Actions runners) — if that happens on this workflow's runner,
                   set DAILY_SOURCES_SKIP=eventbrite there and run --only=eventbrite by hand
                   from an unaffected IP instead.
  --all-cadences  Also run adapters with cadence "weekly" today (default: weekly
                   adapters only run on Mondays Europe/London, or when named in --only).

Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the env to --write.
Optional: SKIDDLE_API_KEY / TICKETMASTER_API_KEY to enable those two adapters
(each skips cleanly, logging why, when its key is missing).
`);
  process.exit(0);
}

const WRITE = process.argv.includes("--write");
const DRY_RUN = !WRITE;
const ALL_CADENCES = process.argv.includes("--all-cadences");

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim())) : null;

const skipArg = process.argv.find((a) => a.startsWith("--skip="));
const SKIP = new Set(
  [
    ...(skipArg ? skipArg.slice("--skip=".length).split(",") : []),
    ...(process.env.DAILY_SOURCES_SKIP ? process.env.DAILY_SOURCES_SKIP.split(",") : []),
  ]
    .map((s) => s.trim())
    .filter(Boolean)
);

if (WRITE && (!SUPABASE_URL || !SERVICE_ROLE_KEY)) {
  console.error(
    "[daily-sources] --write requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. " +
      "Run with: node --env-file=.env.local scripts/daily-sources.mjs --write"
  );
  process.exit(1);
}
if (DRY_RUN && (!SUPABASE_URL || !SERVICE_ROLE_KEY)) {
  console.warn(
    "[daily-sources] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — dry run only, nothing would be written anyway."
  );
}

/** True on Mondays in Europe/London — the day "weekly" adapters run. */
function isLondonMonday(now) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "long" }).format(now) === "Monday";
}

async function main() {
  const now = new Date();
  const selected = ADAPTERS.filter((a) => (!ONLY || ONLY.has(a.name)) && !SKIP.has(a.name));
  if (selected.length === 0) {
    console.error(`[daily-sources] no adapters selected (--only/--skip/DAILY_SOURCES_SKIP left nothing to run; available: ${ADAPTERS.map((a) => a.name).join(", ")})`);
    process.exit(1);
  }
  if (SKIP.size > 0) {
    console.log(`[daily-sources] skipping: ${[...SKIP].join(",")}`);
  }

  // Weekly adapters run on Mondays (Europe/London), when named explicitly in
  // --only, or with --all-cadences.
  const due = selected.filter((a) => {
    if (a.cadence !== "weekly") return true;
    if (ALL_CADENCES || ONLY?.has(a.name) || isLondonMonday(now)) return true;
    console.log(`[daily-sources] not running ${a.name}: weekly adapter, not Monday (pass --only=${a.name} or --all-cadences to force)`);
    return false;
  });
  if (due.length === 0) {
    console.log("[daily-sources] no adapters due today — nothing to do.");
    return;
  }

  console.log(`[daily-sources] mode=${DRY_RUN ? "DRY RUN (pass --write to upsert)" : "WRITE"} sources=${due.map((a) => a.name).join(",")}`);

  const ctx = { now };
  const perSource = [];
  for (const adapter of due) {
    const name = adapter.name;
    const shadow = adapter.status === "shadow";
    console.log(`\n=== ${name}${shadow ? " [shadow]" : ""} ===`);
    try {
      const result = await adapter.run(ctx);
      printSummary(result.provider, result.stats, result.rows, { shadow });
      perSource.push({ ...result, shadow });
    } catch (err) {
      console.error(`[${name}] adapter FAILED entirely: ${err.message}`);
      perSource.push({ provider: name, rows: [], stats: emptyStats(), shadow });
    }
  }

  // Shadow adapters are reported above but never reach dedupe or upsert.
  const live = perSource.filter((s) => !s.shadow);
  const allRows = live.flatMap((s) => s.rows);
  const { rows: merged, collapses } = dedupeAcrossSources(allRows);
  const totalKept = live.reduce((sum, s) => sum + s.rows.length, 0);

  printDedupeSummary({ totalKept, merged, collapses });
  printCategorySummary();

  const blankBefore = merged.filter((r) => !r.description).length;
  const { stats: backfillStats, samples: backfillSamples } = await backfillDescriptions(merged, now);
  const blankAfter = merged.filter((r) => !r.description).length;

  printBackfillSummary({ blankBefore, blankAfter, backfillStats, backfillSamples });

  if (DRY_RUN) {
    console.log("[daily-sources] DRY RUN — pass --write to actually upsert. Nothing written.");
    return;
  }

  const { ok, failed } = await upsertEvents(merged);
  console.log(`[daily-sources] write done: succeeded=${ok} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[daily-sources] fatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
