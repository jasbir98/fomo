import type { User } from "@supabase/supabase-js";
import type { Db } from "@/lib/supabase/types";
import type { Profile } from "@/lib/types";
import { upsertProfile } from "@/lib/db/profile";

export const MAX_DISPLAY_NAME_LENGTH = 50;

/**
 * Write the name in both places it is read from: `profiles.display_name` (what
 * the app shows) and the auth user's `full_name` metadata (so it survives in
 * the session and matches what Google sign-ins already carry). `updateUser`
 * merges metadata, so other keys (`fomo_who`, prefs) are untouched. An empty
 * name clears both. Throws on failure.
 */
export async function saveDisplayName(db: Db, raw: string): Promise<{ profile: Profile; user: User | null }> {
  const name = raw.trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
  const profile = await upsertProfile(db, { display_name: name || null });
  const { data, error } = await db.auth.updateUser({ data: { full_name: name } });
  if (error) throw error;
  return { profile, user: data.user ?? null };
}
