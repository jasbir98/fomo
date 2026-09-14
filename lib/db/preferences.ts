import type { Db } from "@/lib/supabase/types";
import type { TravelPreferences } from "@/lib/types";

/** Fetch the signed-in user's travel preferences. Returns null if none exist yet. RLS scopes this to the caller's own row. */
export async function getPreferences(db: Db): Promise<TravelPreferences | null> {
  const { data, error } = await db.from("travel_preferences").select("*").maybeSingle();
  if (error) throw error;
  return data;
}

/** Create or update the signed-in user's travel preferences (user_id is the PK, filled by the auth.uid() default on insert). */
export async function upsertPreferences(
  db: Db,
  patch: Partial<TravelPreferences>
): Promise<TravelPreferences> {
  const { data, error } = await db
    .from("travel_preferences")
    .upsert({ ...patch }, { onConflict: "user_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}
