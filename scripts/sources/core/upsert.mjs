/**
 * The only writer to the `events` table: upserts via PostgREST (not
 * @supabase/supabase-js — see the note in scripts/daily-sources.mjs).
 */

import { SUPABASE_URL, SERVICE_ROLE_KEY } from "./config.mjs";

export async function upsertEvents(rows) {
  if (rows.length === 0) return { ok: 0, failed: 0 };
  // Null-image clobber guard: image_url must be
  // *omitted* (not null) on rows with no photo, so a re-discovered event's
  // existing image survives an upsert untouched (supabase-js/PostgREST both
  // write every key present in the row object on conflict).
  const withPhoto = rows.filter((r) => r.image_url != null);
  const withoutPhoto = rows.filter((r) => r.image_url == null).map(({ image_url: _image_url, ...rest }) => rest);

  let ok = 0;
  let failed = 0;
  for (const [label, batch] of [["with-photo", withPhoto], ["without-photo", withoutPhoto]]) {
    if (batch.length === 0) continue;
    try {
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
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${res.status}: ${body}`);
      }
      ok += batch.length;
      console.log(`[daily-sources] upserted ${batch.length} row(s) (${label})`);
    } catch (err) {
      failed += batch.length;
      console.error(`[daily-sources] upsert FAILED (${label}, ${batch.length} row(s)): ${err.message}`);
    }
  }
  return { ok, failed };
}
