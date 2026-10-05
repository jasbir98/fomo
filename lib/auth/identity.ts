import type { User } from "@supabase/supabase-js";
import type { Profile } from "@/lib/types";

const MAX_NAME_LENGTH = 50;

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_NAME_LENGTH) : null;
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/**
 * The name to greet someone by: the profile's own `display_name` (what they
 * typed in Fomo) wins, then whatever the sign-in provider supplied (Google
 * sets `full_name`/`name` in user_metadata). `null` when we know no name —
 * callers fall back to the email prefix themselves.
 */
export function displayNameOf(profile: Profile | null | undefined, user: User | null | undefined): string | null {
  const meta = user?.user_metadata as Record<string, unknown> | undefined;
  return cleanName(profile?.display_name) ?? cleanName(meta?.full_name) ?? cleanName(meta?.name);
}

/**
 * Profile photo: an uploaded `profiles.avatar_url` wins over the provider's
 * photo (Google puts it in `avatar_url` or `picture`). Only http(s) strings
 * count — anything else is ignored rather than handed to an <img>.
 */
export function avatarUrlOf(profile: Profile | null | undefined, user: User | null | undefined): string | null {
  const meta = user?.user_metadata as Record<string, unknown> | undefined;
  return httpUrl(profile?.avatar_url) ?? httpUrl(meta?.avatar_url) ?? httpUrl(meta?.picture);
}

/** Up to two uppercase initials from a name ("Ada Lovelace" -> "AL") or, failing that, an email ("ada@x.com" -> "A"). */
export function initialsOf(nameOrEmail: string): string {
  const base = nameOrEmail.includes("@") ? nameOrEmail.split("@")[0] : nameOrEmail;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  const letters = words.map((w) => Array.from(w)[0] ?? "").filter((c) => /\p{L}|\p{N}/u.test(c));
  if (letters.length === 0) return "";
  const picked = letters.length === 1 ? letters : [letters[0], letters[letters.length - 1]];
  return picked.join("").toUpperCase();
}
