/**
 * The only writer to the `events` table: upserts via PostgREST (not
 * @supabase/supabase-js — see the note in scripts/daily-sources.mjs).
 *
 * Lifecycle: every row is stamped `last_seen_at = run start` and `status`
 * ('active', or 'cancelled' when the source said so — see jsonld.mjs /
 * adapters/ticketmaster.mjs). A row that reappears after being retired
 * (gone/cancelled) therefore reverts to active just by being re-upserted.
 * If supabase/add_event_lifecycle.sql hasn't been run yet those columns don't
 * exist; the batch is then retried without them (once warned) so the daily run
 * keeps working during the rollout.
 */

import { SUPABASE_URL, SERVICE_ROLE_KEY } from "./config.mjs";
import { isMissingSchemaError } from "./rest.mjs";

// enriched_at ships in the same SQL file as last_seen_at/status.
const LIFECYCLE_COLUMNS = ["last_seen_at", "status", "enriched_at"];
// Columns that must be OMITTED (not sent as null) when a row has no value, so a
// re-discovered event's existing value survives an upsert untouched: a later
// run that finds no photo / fails to match a venue / skips the page backfill
// must never clear what an earlier run stored.
const CLOBBER_GUARDED = ["image_url", "place_id", "enriched_at"];
let lifecycleColumnsMissing = false;

/**
 * Group rows by which clobber-guarded columns they carry a value for, dropping
 * the null ones. Returns { batches: [{ label, rows }] } (label e.g. "with image_url, place_id"
 * or "plain"), so every object in a batch has the same key set.
 */
export function partitionByGuardedColumns(rows) {
  const groups = new Map();
  for (const row of rows) {
    const present = CLOBBER_GUARDED.filter((c) => row[c] != null);
    const key = present.join("|");
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (CLOBBER_GUARDED.includes(k) && v == null) continue;
      out[k] = v;
    }
    if (!groups.has(key)) groups.set(key, { label: present.length ? `with ${present.join(", ")}` : "plain", rows: [] });
    groups.get(key).rows.push(out);
  }
  return { batches: [...groups.values()] };
}

/** Strip fields that are not real `events` columns (transient validator flags). */
function stripTransient(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!k.startsWith("_")) out[k] = v;
  return out;
}

function withoutLifecycle(row) {
  const out = { ...row };
  for (const c of LIFECYCLE_COLUMNS) delete out[c];
  return out;
}

async function postBatch(batch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/events?on_conflict=provider,provider_event_id`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(batch),
  });
  if (res.ok) return { ok: true };
  const text = await res.text();
  let error;
  try {
    error = JSON.parse(text);
  } catch {
    error = { message: text };
  }
  return { ok: false, status: res.status, error, text };
}

export async function upsertEvents(rows, { runStart = new Date() } = {}) {
  if (rows.length === 0) return { ok: 0, failed: 0 };
  const seenAt = runStart.toISOString();
  const stamped = rows.map((r) => ({ ...stripTransient(r), last_seen_at: seenAt, status: r.status ?? "active" }));

  // Null clobber guard (image_url, place_id, enriched_at): PostgREST writes
  // every key present in a bulk body on conflict, and takes the UNION of keys
  // across the objects, so rows are batched by which guarded columns they
  // actually have and null ones are dropped from the object.
  const { batches } = partitionByGuardedColumns(stamped);

  let ok = 0;
  let failed = 0;
  for (const { label, rows: batch } of batches) {
    if (batch.length === 0) continue;
    try {
      let payload = lifecycleColumnsMissing ? batch.map(withoutLifecycle) : batch;
      let result = await postBatch(payload);
      if (!result.ok && !lifecycleColumnsMissing && isMissingSchemaError(result.error) && /last_seen_at|status|enriched_at/.test(result.text)) {
        lifecycleColumnsMissing = true;
        console.warn(
          "[daily-sources] events.last_seen_at/status/enriched_at columns not found — run supabase/add_event_lifecycle.sql. Upserting without lifecycle fields for now."
        );
        payload = batch.map(withoutLifecycle);
        result = await postBatch(payload);
      }
      if (!result.ok) throw new Error(`${result.status}: ${result.text}`);
      ok += batch.length;
      console.log(`[daily-sources] upserted ${batch.length} row(s) (${label})`);
    } catch (err) {
      failed += batch.length;
      console.error(`[daily-sources] upsert FAILED (${label}, ${batch.length} row(s)): ${err.message}`);
    }
  }
  return { ok, failed, lifecycleColumnsMissing };
}
