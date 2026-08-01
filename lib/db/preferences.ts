import { supabase } from "@/lib/supabase";
import type { TravelPreferences } from "@/lib/types";

/** Fetch travel preferences for a device. Returns null if none exist yet. */
export async function getPreferences(
  deviceId: string
): Promise<TravelPreferences | null> {
  const { data, error } = await supabase
    .from("travel_preferences")
    .select("*")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Create or update travel preferences for a device (device_id is the PK). */
export async function upsertPreferences(
  deviceId: string,
  patch: Partial<TravelPreferences>
): Promise<TravelPreferences> {
  const { data, error } = await supabase
    .from("travel_preferences")
    .upsert({ device_id: deviceId, ...patch }, { onConflict: "device_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}
