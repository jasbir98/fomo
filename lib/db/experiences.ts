import type { Db } from "@/lib/supabase/types";
import type { Experience } from "@/lib/types";

/**
 * List cached experiences (bookable Viator/GetYourGuide tours) for a
 * destination, case-insensitive substring match — mirrors listPlacesByCity's
 * ilike pattern in lib/db/places.ts. Shared catalog table, no user scoping.
 *
 * Takes the first comma-segment of the destination (mirrors cityGuess() in
 * lib/now/context.ts) before stripping remaining punctuation — the stored
 * `destination` column values keep their commas (e.g. "Edinburgh, Edinburgh,
 * Scotland, United Kingdom"), so matching against the full string with only
 * commas removed never matches the literal comma-separated stored value.
 */
export async function listExperiencesByDestination(
  db: Db,
  destination: string
): Promise<Experience[]> {
  const term = destination.split(",")[0]?.trim().replace(/[,()%]/g, "") ?? "";
  if (!term) return [];
  const { data, error } = await db.from("experiences").select("*").ilike("destination", `%${term}%`);
  if (error) throw error;
  return data ?? [];
}

/**
 * Batch-fetch experiences by id — mirrors listPlacesByIds (lib/db/places.ts)
 * and listEventsByIds (lib/db/events.ts). Used by GET /api/saved to resolve
 * saved_items rows with subject_type "experience" back into full rows.
 */
export async function listExperiencesByIds(db: Db, ids: string[]): Promise<Experience[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db.from("experiences").select("*").in("id", ids);
  if (error) throw error;
  return data ?? [];
}

/** Fetch a single experience by id. Returns null if not found. */
export async function getExperience(db: Db, id: string): Promise<Experience | null> {
  const { data, error } = await db.from("experiences").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Free-text search over cached experiences (title only), case-insensitive
 * substring match — mirrors searchPlacesByName's pattern in lib/db/places.ts.
 */
export async function searchExperiences(db: Db, q: string): Promise<Experience[]> {
  const term = q.trim().replace(/[,()%]/g, "");
  if (!term) return [];
  const { data, error } = await db.from("experiences").select("*").ilike("title", `%${term}%`);
  if (error) throw error;
  return data ?? [];
}
