#!/usr/bin/env node
/**
 * check-event-sample.mjs — spot-check that events say what the source said.
 *
 * Picks random rows for a provider, fetches each row's own ticket_url (through
 * the same politeFetch as the ingest: robots.txt, per-host rate limit,
 * challenge detection), and checks that >=60% of the significant title words
 * and the event's Europe/London date (in any common format) appear on the page.
 * Prints per-row pass/fail and an accuracy %; a new source needs >=90% to go
 * live (docs/plans/2026-10-08-event-and-deal-coverage.md, Phase 2).
 *
 *   node --env-file=.env.local scripts/check-event-sample.mjs --provider=skiddle --n=10
 *   --source=db        (default) random upcoming ACTIVE rows from the events table
 *   --source=dry-run   run `daily-sources.mjs --only=<provider> --dump=...` first and sample that
 *   --from-file=p.json rows from a `daily-sources.mjs --dump=p.json` file (e.g. shadow adapters)
 *
 * Exit code is always 0; read the PASS/FAIL line. Rows whose page can't be
 * fetched (robots, block, timeout) are reported as "unchecked" and excluded
 * from the accuracy. Appends a line to $GITHUB_STEP_SUMMARY when set.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { politeFetch } from "./sources/core/fetch.mjs";
import { hasSupabase, isMissingSchemaError, restGetAll } from "./sources/core/rest.mjs";
import { checkRowAgainstHtml } from "./lib/sample-check.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, ...v] = a.slice(2).split("=");
      return [k, v.length ? v.join("=") : "true"];
    })
);

if (args.help || !args.provider && !args["from-file"]) {
  console.log(`Usage: node --env-file=.env.local scripts/check-event-sample.mjs --provider=<name> [--n=10] [--source=db|dry-run] [--from-file=path.json]`);
  process.exit(0);
}

const N = Math.max(1, Number(args.n ?? 10) || 10);
const PASS_THRESHOLD = 0.9;

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function rowsFromDb(provider) {
  if (!hasSupabase()) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (use --from-file instead)");
  const base =
    `events?select=provider,provider_event_id,name,venue_name,starts_at,ticket_url` +
    `&provider=eq.${encodeURIComponent(provider)}&starts_at=gte.${encodeURIComponent(new Date().toISOString())}&ticket_url=not.is.null&order=id.asc`;
  let res = await restGetAll(`${base}&status=eq.active`);
  if (!res.ok && isMissingSchemaError(res.error)) res = await restGetAll(base); // lifecycle SQL not applied yet
  if (!res.ok) throw new Error(`DB read failed: ${JSON.stringify(res.error)}`);
  return res.rows;
}

function rowsFromDryRun(provider) {
  const dir = mkdtempSync(join(tmpdir(), "event-sample-"));
  const dump = join(dir, "dump.json");
  console.log(`[check-sample] running a dry run for ${provider} ...`);
  const r = spawnSync(process.execPath, ["scripts/daily-sources.mjs", `--only=${provider}`, `--dump=${dump}`], { stdio: ["ignore", "ignore", "inherit"], env: process.env });
  if (r.status !== 0) throw new Error(`dry run exited ${r.status}`);
  return rowsFromFile(dump, provider);
}

function rowsFromFile(path, provider) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const rows = Array.isArray(parsed) ? parsed : parsed.rows ?? [];
  return rows.filter((r) => (!provider || r.provider === provider) && r.ticket_url);
}

async function main() {
  const provider = args.provider ?? null;
  let candidates;
  let sourceLabel;
  if (args["from-file"]) {
    candidates = rowsFromFile(args["from-file"], provider);
    sourceLabel = `file ${args["from-file"]}`;
  } else if (args.source === "dry-run") {
    candidates = rowsFromDryRun(provider);
    sourceLabel = "dry run";
  } else {
    candidates = await rowsFromDb(provider);
    sourceLabel = "db";
  }
  const label = provider ?? "(all providers in file)";
  if (candidates.length === 0) {
    console.log(`[check-sample] ${label}: no rows with a ticket_url to sample from ${sourceLabel}.`);
    console.log("RESULT: no data (nothing checked)");
    return;
  }

  const sample = shuffle(candidates).slice(0, N);
  console.log(`[check-sample] ${label}: sampling ${sample.length} of ${candidates.length} rows from ${sourceLabel}\n`);

  let checked = 0;
  let passed = 0;
  let unchecked = 0;
  for (const row of sample) {
    // Check the ticket page first. Some sources (Forever Edinburgh) are read
    // from their own page but link out to a third-party ticket page, so when
    // provider_event_id is that source page, a pass there counts too.
    const urls = [row.ticket_url];
    if (/^https?:\/\//.test(row.provider_event_id ?? "") && row.provider_event_id !== row.ticket_url) urls.push(row.provider_event_id);
    let r = null;
    let usedUrl = null;
    let lastReason = null;
    for (const url of urls) {
      const page = await politeFetch(url);
      if (!page.ok) {
        lastReason = page.reason;
        continue;
      }
      r = checkRowAgainstHtml(row, page.html);
      usedUrl = url;
      if (r.pass) break;
    }
    if (!r) {
      unchecked += 1;
      console.log(`  UNCHECKED  "${row.name}" -> ${lastReason} | ${row.ticket_url}`);
      continue;
    }
    checked += 1;
    if (r.pass) passed += 1;
    console.log(
      `  ${r.pass ? "PASS     " : "FAIL     "}  "${row.name}" | title ${Math.round(r.titlePct * 100)}% | date ${r.ymd} ${r.dateFound ? "found" : "NOT found"} | ${usedUrl}`
    );
  }

  const accuracy = checked > 0 ? passed / checked : null;
  const pct = accuracy == null ? "n/a" : `${Math.round(accuracy * 100)}%`;
  const verdict = accuracy == null ? "NO DATA (every page was unfetchable)" : accuracy >= PASS_THRESHOLD ? "PASS (>=90%)" : "FAIL (<90%)";
  console.log(`\n[check-sample] ${label}: accuracy ${pct} (${passed}/${checked} checked, ${unchecked} unchecked)`);
  console.log(`RESULT: ${verdict}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `| ${label} | ${pct} (${passed}/${checked}, ${unchecked} unchecked) | ${verdict} |\n`);
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(`[check-sample] error: ${err.message}`);
  console.log("RESULT: error (see above)");
});
