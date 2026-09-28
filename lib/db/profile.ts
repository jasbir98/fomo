import type { Db } from "@/lib/supabase/types";
import type { NotificationSettings, PrivacySettings, Profile, ProfileUpdate } from "@/lib/types";

/** Mirrors the column default in supabase/archive/add_profile_settings.sql. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  trip_reminders: true,
  weekly_digest: false,
  ai_suggestions: true,
};

/** Mirrors the column default in supabase/archive/add_profile_settings.sql. */
export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  personalized_recommendations: true,
  precise_location: true,
  share_usage_data: true,
};

/** Fetch the signed-in user's profile row. Returns null if none exists yet (shouldn't happen post-signup trigger, but the row may not have landed yet). RLS scopes this to the caller's own row. */
export async function getProfile(db: Db): Promise<Profile | null> {
  const { data, error } = await db.from("profiles").select("*").maybeSingle();
  if (error) throw error;
  return data;
}

/** Create or update the signed-in user's profile row (user_id is the PK, filled by the auth.uid() default on insert). RLS's `with check` guards the write. */
export async function upsertProfile(db: Db, patch: ProfileUpdate): Promise<Profile> {
  const { data, error } = await db
    .from("profiles")
    .upsert({ ...patch }, { onConflict: "user_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** Maps a MIME type to a safe, known storage extension. */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Derives a safe extension from the file's MIME type, falling back to its original name. */
function safeExtension(file: File): string {
  const fromMime = MIME_EXTENSIONS[file.type];
  if (fromMime) return fromMime;
  const match = /\.([a-zA-Z0-9]+)$/.exec(file.name);
  const ext = match?.[1]?.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext && ext.length <= 5 ? ext : "jpg";
}

/**
 * Upload the signed-in user's avatar to the `avatars` Storage bucket (see
 * supabase/archive/add_avatars_storage.sql) and return its public URL. Caller is
 * responsible for saving the URL onto the profile via upsertProfile.
 *
 * The storage key is built entirely from the user id, a timestamp, and a
 * sanitized extension — never the raw original filename. Supabase's
 * `getPublicUrl` does not URL-encode the storage path, so filenames with
 * spaces, `#`, `?`, `%`, or non-ASCII characters (common from camera-roll
 * exports) would otherwise produce a broken public URL that silently fails
 * to load.
 *
 * The `${userId}/…` path prefix is what supabase/archive/harden_rls.sql's
 * `avatars_own_folder` storage policy checks against
 * `(storage.foldername(name))[1] = auth.uid()::text` — passing anything else
 * here will be rejected by RLS once that migration has run.
 */
export async function uploadAvatar(db: Db, userId: string, file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file.");
  }
  if (file.size > MAX_AVATAR_BYTES) {
    throw new Error("Image is too large — please choose one under 5MB.");
  }

  const path = `${userId}/${Date.now()}.${safeExtension(file)}`;
  const { error } = await db.storage.from("avatars").upload(path, file, {
    upsert: true,
  });
  if (error) throw error;

  return db.storage.from("avatars").getPublicUrl(path).data.publicUrl;
}
