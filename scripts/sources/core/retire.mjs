/**
 * Soft-retirement of events (never a DELETE). Runs after the upserts, only
 * with --write; a dry run only previews counts + samples.
 *
 *   a. status='expired' for active/gone/cancelled rows whose end has passed
 *      (ends_at, or for rows without one: starts_at + the app's default
 *      2h duration — the same definition as lib/events/format.ts, so a
 *      still-running event is never expired out from under the feed).
 *   b. status='gone' for ACTIVE rows not seen for 3 days that start within
 *      the next 25 days — but only for providers whose last 3 London calendar
 *      days each have a healthy run (ok, kept>0, status 'live') in
 *      event_source_runs. A source that failed or came back empty never
 *      retires its own rows ("not retired: source unhealthy").
 *
 * A gone/cancelled row that shows up in its source again reverts to active
 * through the normal upsert (core/upsert.mjs sets status + last_seen_at).
 * If the lifecycle columns/table don't exist yet we print a pointer to
 * supabase/add_event_lifecycle.sql and skip, without failing the run.
 */

import { hasSupabase, isMissingSchemaError, rest, restGetAll, totalFromContentRange } from "./rest.mjs";
import { londonDateKey } from "./time.mjs";

export const GONE_UNSEEN_DAYS = 3;
export const GONE_MAX_DAYS_AHEAD = 25;
export const HEALTHY_DAYS_REQUIRED = 3;
export const DEFAULT_EVENT_DURATION_MS = 2 * 60 * 60 * 1000; // keep in sync with lib/events/format.ts
const DAY_MS = 24 * 60 * 60 * 1000;

const MIGRATION_HINT = "run supabase/add_event_lifecycle.sql in the Supabase SQL editor";

/** The last `n` London calendar days (today first) as YYYY-MM-DD keys. */
export function lastLondonDays(now, n = HEALTHY_DAYS_REQUIRED) {
  const today = londonDateKey(now.toISOString());
  const [y, m, d] = today.split("-").map(Number);
  const days = [];
  for (let i = 0; i < n; i++) {
    days.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Pure: providers with a healthy run on every one of the last 3 London days.
 * `runs` = event_source_runs rows ({provider, started_at, ok, kept, status}).
 * `todayHealthy` (dry run only) = providers whose in-memory result today is healthy.
 */
export function healthyProviders(runs, now, { todayHealthy = [] } = {}) {
  const required = lastLondonDays(now);
  const byProvider = new Map();
  for (const r of runs) {
    if (!r.ok || !(r.kept > 0) || r.status !== "live") continue;
    const day = londonDateKey(r.started_at);
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, new Set());
    byProvider.get(r.provider).add(day);
  }
  for (const p of todayHealthy) {
    if (!byProvider.has(p)) byProvider.set(p, new Set());
    byProvider.get(p).add(required[0]);
  }
  const healthy = new Set();
  for (const [provider, days] of byProvider) {
    if (required.every((d) => days.has(d))) healthy.add(provider);
  }
  return healthy;
}

const enc = encodeURIComponent;

function sampleLine(r) {
  const seen = r.last_seen_at ? ` last_seen=${String(r.last_seen_at).slice(0, 10)}` : "";
  return `    [${r.provider}] "${r.name}" @ ${r.starts_at}${r.status ? ` (was ${r.status})` : ""}${seen}`;
}

function expiredFilter(now, { legacy = false } = {}) {
  const cutoff = new Date(now.getTime() - DEFAULT_EVENT_DURATION_MS).toISOString();
  const nowIso = now.toISOString();
  return (
    (legacy ? "" : `status=in.(active,gone,cancelled)&`) +
    `or=${enc(`(ends_at.lt.${nowIso},and(ends_at.is.null,starts_at.lt.${cutoff}))`)}`
  );
}

async function retireExpired(now, { write, legacy = false }) {
  const filter = expiredFilter(now, { legacy });
  const preview = await rest(`events?select=id,provider,name,starts_at,ends_at${legacy ? "" : ",status"}&${filter}&order=starts_at.desc`, {
    range: "0-9",
    prefer: "count=exact",
  });
  if (!preview.ok) return { error: preview.error };
  const total = totalFromContentRange(preview.contentRange) ?? preview.data.length;
  let changed = 0;
  if (write && total > 0) {
    const patch = await rest(`events?select=id&${filter}`, {
      method: "PATCH",
      body: { status: "expired" },
      prefer: "return=representation",
    });
    if (!patch.ok) return { error: patch.error };
    changed = Array.isArray(patch.data) ? patch.data.length : 0;
  }
  return { total, changed, samples: preview.data };
}

async function loadHealthRuns(now) {
  const since = new Date(now.getTime() - (HEALTHY_DAYS_REQUIRED + 2) * DAY_MS).toISOString();
  return restGetAll(`event_source_runs?select=provider,started_at,ok,kept,status&started_at=gte.${enc(since)}&order=started_at.asc`);
}

async function retireGone(now, { write, todayHealthy, legacy = false }) {
  const seenBefore = new Date(now.getTime() - GONE_UNSEEN_DAYS * DAY_MS).toISOString();
  const nowIso = now.toISOString();
  const horizon = new Date(now.getTime() + GONE_MAX_DAYS_AHEAD * DAY_MS).toISOString();
  // legacy (dry-run preview before the SQL has run): no status/last_seen_at
  // columns yet, so approximate with fetched_at and treat every row as active.
  const baseFilter =
    (legacy ? "" : `status=eq.active&`) +
    `${legacy ? "fetched_at" : "last_seen_at"}=lt.${enc(seenBefore)}` +
    `&and=${enc(`(starts_at.gt.${nowIso},starts_at.lt.${horizon})`)}`;

  const candidates = await restGetAll(
    `events?select=id,provider,name,starts_at,${legacy ? "fetched_at" : "last_seen_at,status"}&${baseFilter}&order=starts_at.asc`
  );
  if (!candidates.ok) return { error: candidates.error };

  const runs = legacy ? { ok: true, rows: [] } : await loadHealthRuns(now);
  if (!runs.ok) return { error: runs.error };
  const healthy = healthyProviders(runs.rows, now, { todayHealthy });

  const retire = candidates.rows.filter((r) => healthy.has(r.provider));
  const unhealthy = {};
  for (const r of candidates.rows) {
    if (!healthy.has(r.provider)) unhealthy[r.provider] = (unhealthy[r.provider] ?? 0) + 1;
  }

  let changed = 0;
  const retireProviders = [...new Set(retire.map((r) => r.provider))];
  if (write && retireProviders.length > 0) {
    const list = retireProviders.map((p) => `"${p.replace(/"/g, "")}"`).join(",");
    const patch = await rest(`events?select=id&${baseFilter}&provider=in.(${enc(list)})`, {
      method: "PATCH",
      body: { status: "gone" },
      prefer: "return=representation",
    });
    if (!patch.ok) return { error: patch.error };
    changed = Array.isArray(patch.data) ? patch.data.length : 0;
  }
  return { total: retire.length, changed, samples: retire.slice(0, 10), unhealthy, healthyCount: healthy.size };
}

/**
 * Run both retirement steps. `write` false = preview only.
 * `todayHealthy`: providers whose in-memory result this run is healthy (used
 * in dry runs, where today's event_source_runs row isn't written).
 */
export async function retireEvents(now, { write, todayHealthy = [] } = {}) {
  const label = write ? "retire" : "retire (preview)";
  if (!hasSupabase()) {
    console.log(`[daily-sources] ${label}: skipped (no Supabase credentials in env)`);
    return { skipped: true };
  }

  let legacy = false;
  let expired = await retireExpired(now, { write });
  if (expired.error && isMissingSchemaError(expired.error) && !write) {
    // Dry run before the SQL has been applied: still show what the rules would
    // do, approximated on the columns that exist today.
    console.warn(`[daily-sources] ${label}: events.status not found — ${MIGRATION_HINT}. Showing an approximate preview from the old columns (fetched_at stands in for last_seen_at; no run history yet, so every source reads as unhealthy).`);
    legacy = true;
    expired = await retireExpired(now, { write, legacy });
  }
  if (expired.error) {
    if (isMissingSchemaError(expired.error)) {
      console.warn(`[daily-sources] ${label}: events.status not found — ${MIGRATION_HINT}. Skipping retirement.`);
    } else {
      console.warn(`[daily-sources] ${label}: expire step failed: ${JSON.stringify(expired.error)} — skipping retirement.`);
    }
    return { skipped: true };
  }
  console.log(
    `\n[daily-sources] ${label}: ${write ? `expired ${expired.changed}` : `WOULD expire ${expired.total}`} ` +
      `row(s) whose end has passed (active/gone/cancelled -> expired)`
  );
  for (const r of expired.samples) console.log(sampleLine(r));

  const gone = await retireGone(now, { write, todayHealthy, legacy });
  if (gone.error) {
    if (isMissingSchemaError(gone.error)) {
      console.warn(`[daily-sources] ${label}: events.last_seen_at or event_source_runs not found — ${MIGRATION_HINT}. Skipping the 'gone' step.`);
    } else {
      console.warn(`[daily-sources] ${label}: 'gone' step failed: ${JSON.stringify(gone.error)} — skipping it.`);
    }
    return { expired, skipped: false };
  }
  console.log(
    `[daily-sources] ${label}: ${write ? `marked ${gone.changed}` : `WOULD mark ${gone.total}`} ` +
      `active row(s) gone (unseen >${GONE_UNSEEN_DAYS}d, starting within ${GONE_MAX_DAYS_AHEAD}d, source healthy ${HEALTHY_DAYS_REQUIRED} days running)`
  );
  for (const r of gone.samples) console.log(sampleLine(r));
  const unhealthyEntries = Object.entries(gone.unhealthy);
  if (unhealthyEntries.length > 0) {
    console.log(
      `[daily-sources] ${label}: not retired: source unhealthy -> ` +
        unhealthyEntries.map(([p, n]) => `${p} (${n} candidate row(s))`).join(", ")
    );
  }
  return { expired, gone, skipped: false };
}
