import { supabase } from "@/lib/supabase";
import type { CardSubjectType, SavedItem, SavedItemInsert } from "@/lib/types";

/** All saved items for a device (optionally scoped to one trip), newest first. */
export async function listSavedItems(
  deviceId: string,
  tripId?: string
): Promise<SavedItem[]> {
  let query = supabase
    .from("saved_items")
    .select("*")
    .eq("device_id", deviceId)
    .order("created_at", { ascending: false });
  if (tripId) query = query.eq("trip_id", tripId);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/** Whether a specific subject is already saved by this device. */
export async function isSaved(
  deviceId: string,
  subjectType: CardSubjectType,
  subjectId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("saved_items")
    .select("id")
    .eq("device_id", deviceId)
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .maybeSingle();
  if (error) throw error;
  return data != null;
}

/** Save a card. Upserts on (device_id, subject_type, subject_id) — tapping Save twice is a no-op, not a duplicate. */
export async function saveItem(patch: SavedItemInsert): Promise<SavedItem> {
  const { data, error } = await supabase
    .from("saved_items")
    .upsert(patch, { onConflict: "device_id,subject_type,subject_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/** Un-save a card. */
export async function unsaveItem(
  deviceId: string,
  subjectType: CardSubjectType,
  subjectId: string
): Promise<void> {
  const { error } = await supabase
    .from("saved_items")
    .delete()
    .eq("device_id", deviceId)
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId);
  if (error) throw error;
}
