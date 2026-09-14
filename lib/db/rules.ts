import type { Db } from "@/lib/supabase/types";
import type { FomoRules } from "@/lib/types";

// TS type renamed Roameo -> Fomo; the underlying Supabase table is intentionally
// still named "roameo_rules" (renaming a live table is a migration for zero user benefit).

/** Fetch the signed-in user's Fomo rules row. Returns null if none exist yet. RLS scopes this to the caller's own row. */
export async function getRules(db: Db): Promise<FomoRules | null> {
  const { data, error } = await db.from("roameo_rules").select("*").maybeSingle();
  if (error) throw error;
  return data;
}

/** Create or update the signed-in user's rules row (user_id is the PK, filled by the auth.uid() default on insert). */
export async function upsertRules(
  db: Db,
  patch: { rules_text?: string | null; quick_chips?: string[] }
): Promise<FomoRules> {
  const { data, error } = await db
    .from("roameo_rules")
    .upsert({ ...patch }, { onConflict: "user_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}
