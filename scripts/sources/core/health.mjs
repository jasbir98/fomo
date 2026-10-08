/**
 * "Source health" table: per provider, this run's kept count vs the 7-day
 * median of earlier runs. Flags:
 *   ZERO_TWICE  kept=0 on this run and on the previous run
 *   DROP        kept < 40% of the 7-day median (median > 0)
 * Printed to stdout and appended to $GITHUB_STEP_SUMMARY when set.
 * Dry runs have no history: the table shows today's in-memory counts only.
 */

import { appendFileSync } from "node:fs";
import { hasSupabase, isMissingSchemaError, restGetAll } from "./rest.mjs";

export const DROP_RATIO = 0.4;
const DAY_MS = 24 * 60 * 60 * 1000;

export function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Pure. `current` = [{provider, kept, shadow}] for this run; `history` =
 * event_source_runs rows (any order) from the last ~8 days EXCLUDING this run.
 * Returns [{provider, shadow, kept, median, flags: []}].
 */
export function computeHealth(current, history, now) {
  const sevenDaysAgo = now.getTime() - 7 * DAY_MS;
  return current.map((c) => {
    const past = history
      .filter((h) => h.provider === c.provider)
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
    const inWindow = past.filter((h) => new Date(h.started_at).getTime() >= sevenDaysAgo);
    const med = median(inWindow.map((h) => h.kept ?? 0));
    const flags = [];
    if (c.kept === 0 && past.length > 0 && (past[0].kept ?? 0) === 0) flags.push("ZERO_TWICE");
    if (med != null && med > 0 && c.kept < DROP_RATIO * med) flags.push("DROP");
    return { provider: c.provider, shadow: Boolean(c.shadow), kept: c.kept, median: med, flags };
  });
}

function fmtMedian(m) {
  if (m == null) return "-";
  return Number.isInteger(m) ? String(m) : m.toFixed(1);
}

export function renderHealthText(rows, { dryRun }) {
  const lines = [`[daily-sources] Source health${dryRun ? " (dry run: today's counts only, no history)" : ""}`];
  lines.push(`    ${"provider".padEnd(16)} ${"kept".padStart(6)} ${"7d median".padStart(10)}  flag`);
  for (const r of rows) {
    const flag = r.flags.join(",") || (dryRun && r.kept === 0 ? "ZERO_NOW" : "");
    lines.push(`    ${(r.provider + (r.shadow ? " [shadow]" : "")).padEnd(16)} ${String(r.kept).padStart(6)} ${fmtMedian(r.median).padStart(10)}  ${flag}`);
  }
  return lines.join("\n");
}

export function renderHealthMarkdown(rows, { dryRun }) {
  const out = [`### Source health${dryRun ? " (dry run)" : ""}`, "", "| provider | kept today | 7-day median | flag |", "| --- | ---: | ---: | --- |"];
  for (const r of rows) {
    out.push(`| ${r.provider}${r.shadow ? " (shadow)" : ""} | ${r.kept} | ${fmtMedian(r.median)} | ${r.flags.join(", ") || (dryRun && r.kept === 0 ? "ZERO_NOW" : "")} |`);
  }
  return out.join("\n") + "\n";
}

/** Fetch the last 8 days of runs for this run's providers (excluding `runId`) and report. */
export async function reportHealth(perSource, { now, dryRun, runId }) {
  const current = perSource.map((s) => ({ provider: s.provider, kept: s.rows.length, shadow: s.shadow }));
  let history = [];
  if (!dryRun && hasSupabase()) {
    const since = new Date(now.getTime() - 8 * DAY_MS).toISOString();
    const res = await restGetAll(
      `event_source_runs?select=run_id,provider,started_at,kept&started_at=gte.${encodeURIComponent(since)}&order=started_at.desc`
    );
    if (res.ok) {
      history = res.rows.filter((r) => r.run_id !== runId);
    } else if (isMissingSchemaError(res.error)) {
      console.warn("[daily-sources] event_source_runs not found — run supabase/add_event_lifecycle.sql; health table has no history.");
    } else {
      console.warn(`[daily-sources] could not read event_source_runs for the health table: ${JSON.stringify(res.error)}`);
    }
  }
  const rows = computeHealth(current, history, now);
  console.log("\n" + renderHealthText(rows, { dryRun }));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, "\n" + renderHealthMarkdown(rows, { dryRun }));
    } catch (err) {
      console.warn(`[daily-sources] could not write GITHUB_STEP_SUMMARY: ${err.message}`);
    }
  }
  return rows;
}
