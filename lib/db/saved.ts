import type { Db } from "@/lib/supabase/types";
import type { CardSubjectType, SavedItem, SavedItemInsert } from "@/lib/types";

/** All saved items for the signed-in caller, newest first. RLS scopes this to the caller's own rows. */
export async function listSavedItems(db: Db): Promise<SavedItem[]> {
  const { data, error } = await db
    .from("saved_items")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * One page of the caller's saved items, newest first — the /saved page
 * (app/(shell)/saved/page.tsx) reads through this via GET /api/saved for
 * lib/useInfiniteList.ts pagination, instead of listSavedItems' fetch-all
 * (which stays as-is for lib/now/context.ts's ranker read, where the whole
 * shortlist is small and needed in one shot). Deliberately NOT trip-scoped —
 * mirrors listSavedItems' own default and the `saved` rail's "any trip"
 * doc comment (lib/now/types.ts) — a saved item stays visible after the
 * traveler starts a new trip.
 */
export async function listSavedItemsPage(
  db: Db,
  { limit, offset }: { limit: number; offset: number }
): Promise<SavedItem[]> {
  const { data, error } = await db
    .from("saved_items")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data ?? [];
}

/** Whether a specific subject is already saved by the signed-in caller. */
export async function isSaved(
  db: Db,
  subjectType: CardSubjectType,
  subjectId: string
): Promise<boolean> {
  const { data, error } = await db
    .from("saved_items")
    .select("id")
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .maybeSingle();
  if (error) throw error;
  return data != null;
}

/**
 * Save a card. Upserts on (user_id, subject_type, subject_id) — tapping Save
 * twice is a no-op, not a duplicate. `trip_id` is always written null —
 * Fomo has no trips anymore; the column stays in the DB, unused.
 */
export async function saveItem(db: Db, patch: SavedItemInsert): Promise<SavedItem> {
  const { data, error } = await db
    .from("saved_items")
    .upsert({ ...patch, trip_id: null }, { onConflict: "user_id,subject_type,subject_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/** Un-save a card. */
export async function unsaveItem(
  db: Db,
  subjectType: CardSubjectType,
  subjectId: string
): Promise<void> {
  const { error } = await db
    .from("saved_items")
    .delete()
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId);
  if (error) throw error;
}
