import type { Db } from "@/lib/supabase/types";

/**
 * Fomo — push subscription + on-sale alert CRUD.
 *
 * All four functions take a user-scoped `Db` (supabaseServer() from a route
 * handler, or supabaseBrowserAuth() from a client component) so RLS's
 * `own_rows` policies (supabase/archive/add_push_alerts.sql) do the actual identity
 * scoping — same convention as lib/db/saved.ts. Never pass supabaseAdmin()
 * here; that's reserved for the sender Edge Function, which lives outside
 * this app and reads/writes with the service role directly.
 */

export interface PushSubscriptionUpsert {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/** Upsert-by-endpoint — re-registering the same device (e.g. after a permission re-grant) updates the existing row instead of duplicating it. */
export async function upsertPushSubscription(db: Db, sub: PushSubscriptionUpsert): Promise<void> {
  const { error } = await db.from("push_subscriptions").upsert(
    {
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      user_agent: sub.userAgent ?? null,
    },
    { onConflict: "endpoint" }
  );
  if (error) throw error;
}

/** Remove this device's subscription (both an explicit unsubscribe, and cleanup after the browser reports the subscription gone). */
export async function deletePushSubscriptionByEndpoint(db: Db, endpoint: string): Promise<void> {
  const { error } = await db.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) throw error;
}

/** Every happening id the signed-in caller has an on-sale alert for — used on Home load so a Book Early card's "Notify me" renders as already-subscribed instead of resetting per page load. */
export async function listAlertHappeningIds(db: Db): Promise<string[]> {
  const { data, error } = await db.from("onsale_alerts").select("happening_id");
  if (error) throw error;
  return (data ?? []).map((row) => row.happening_id as string);
}

/** Create (or no-op if it already exists) an on-sale alert for one happening. Upserts on (user_id, happening_id) — tapping "Notify me" twice is a no-op, matching saveItem's own idempotency convention. */
export async function createAlert(db: Db, happeningId: string): Promise<void> {
  const { error } = await db
    .from("onsale_alerts")
    .upsert({ happening_id: happeningId }, { onConflict: "user_id,happening_id" });
  if (error) throw error;
}

/** Remove an on-sale alert. */
export async function deleteAlert(db: Db, happeningId: string): Promise<void> {
  const { error } = await db.from("onsale_alerts").delete().eq("happening_id", happeningId);
  if (error) throw error;
}
