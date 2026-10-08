/**
 * event_source_runs: one row per adapter per --write run (shadow adapters
 * too, status 'shadow'). Feeds the retirement health gate (core/retire.mjs)
 * and the "Source health" table (core/health.mjs).
 */

import { hasSupabase, isMissingSchemaError, rest } from "./rest.mjs";

/**
 * Build the rows to insert. `perSource` entries: { provider, shadow, rows, stats, error? }.
 * `upserted` = the final merged rows (what actually gets written) and `existing`
 * = Map "provider|id" -> image from the pre-run lookup (null if unknown), used to
 * split inserted vs updated.
 */
export function buildRunRows({ runId, startedAt, perSource, upserted = [], existing = null }) {
  return perSource.map((s) => {
    let inserted = null;
    let updated = null;
    if (!s.shadow && existing) {
      inserted = 0;
      updated = 0;
      for (const r of upserted) {
        if (r.provider !== s.provider) continue;
        if (existing.has(`${r.provider}|${r.provider_event_id}`)) updated += 1;
        else inserted += 1;
      }
    } else if (s.shadow) {
      inserted = 0;
      updated = 0;
    }
    const fetched = s.stats?.fetched ?? 0;
    const failed = Boolean(s.error);
    const ok = !failed && fetched > 0;
    return {
      run_id: runId,
      provider: s.provider,
      started_at: startedAt.toISOString(),
      ok,
      status: s.shadow ? "shadow" : "live",
      fetched,
      kept: s.rows.length,
      inserted,
      updated,
      rejected: s.stats?.rejected ?? {},
      error: failed ? String(s.error).slice(0, 500) : fetched === 0 ? "nothing fetched (skipped, blocked or empty)" : null,
    };
  });
}

let warnedMissing = false;

/** Insert the run rows. A missing table warns once and returns false; never throws. */
export async function recordRuns(runRows) {
  if (!hasSupabase() || runRows.length === 0) return false;
  const res = await rest("event_source_runs", { method: "POST", body: runRows, prefer: "return=minimal" });
  if (res.ok) {
    console.log(`[daily-sources] recorded ${runRows.length} event_source_runs row(s)`);
    return true;
  }
  if (isMissingSchemaError(res.error)) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn("[daily-sources] event_source_runs table not found — run supabase/add_event_lifecycle.sql in the Supabase SQL editor. Run history not recorded.");
    }
  } else {
    console.warn(`[daily-sources] could not record event_source_runs: ${res.status} ${JSON.stringify(res.error)}`);
  }
  return false;
}
