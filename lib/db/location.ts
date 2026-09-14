import type { Db } from "@/lib/supabase/types";
import type { DeviceLocation } from "@/lib/types";

/** Raw CRUD on `user_location` (renamed from `device_location` in
 * supabase/add_auth_identity.sql — see plan-v1.2-accounts.md §A.5). Callers
 * (lib/now/location.ts) own the coarsening (rounding) and
 * permission-revoked deletion policy — this module just persists whatever
 * it's given. RLS scopes every call to the signed-in caller's own row. */

export async function getUserLocation(db: Db): Promise<DeviceLocation | null> {
  const { data, error } = await db.from("user_location").select("*").maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertUserLocation(db: Db, lat: number, lng: number): Promise<void> {
  const { error } = await db
    .from("user_location")
    .upsert({ lat, lng, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) throw error;
}

export async function deleteUserLocation(db: Db): Promise<void> {
  // Supabase's Postgres enables the safeupdate extension, which rejects any
  // DELETE/UPDATE with no WHERE clause at all — regardless of RLS — with
  // code 21000 "DELETE requires a WHERE clause" (surfaces to the client as a
  // 400). RLS's own_rows policy is still what actually scopes the row to the
  // caller (there's at most one, user_id is the PK); this `.not(...)` filter
  // just satisfies the safety check with an always-true condition.
  const { error } = await db.from("user_location").delete().not("user_id", "is", null);
  if (error) throw error;
}
