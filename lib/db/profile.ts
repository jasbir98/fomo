import { supabase } from "@/lib/supabase";
import type { NotificationSettings, PrivacySettings, Profile, ProfileUpdate } from "@/lib/types";

/** Mirrors the column default in supabase/add_profile_settings.sql. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  trip_reminders: true,
  weekly_digest: false,
  ai_suggestions: true,
};

/** Mirrors the column default in supabase/add_profile_settings.sql. */
export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  personalized_recommendations: true,
  precise_location: true,
  share_usage_data: true,
};

/** Fetch the profile row for a device. Returns null if none exists yet. */
export async function getProfile(deviceId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Create or update the profile row for a device (device_id is the PK). */
export async function upsertProfile(
  deviceId: string,
  patch: ProfileUpdate
): Promise<Profile> {
  const { data, error } = await supabase
    .from("profiles")
    .upsert({ device_id: deviceId, ...patch }, { onConflict: "device_id" })
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
 * Upload a device's avatar to the `avatars` Storage bucket (see
 * supabase/add_avatars_storage.sql) and return its public URL. Caller is
 * responsible for saving the URL onto the profile via upsertProfile.
 *
 * The storage key is built entirely from the device id, a timestamp, and a
 * sanitized extension — never the raw original filename. Supabase's
 * `getPublicUrl` does not URL-encode the storage path, so filenames with
 * spaces, `#`, `?`, `%`, or non-ASCII characters (common from camera-roll
 * exports) would otherwise produce a broken public URL that silently fails
 * to load.
 */
export async function uploadAvatar(deviceId: string, file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file.");
  }
  if (file.size > MAX_AVATAR_BYTES) {
    throw new Error("Image is too large — please choose one under 5MB.");
  }

  const path = `${deviceId}/${Date.now()}.${safeExtension(file)}`;
  const { error } = await supabase.storage.from("avatars").upload(path, file, {
    upsert: true,
  });
  if (error) throw error;

  return supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
}
