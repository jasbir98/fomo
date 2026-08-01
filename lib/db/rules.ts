import { supabase } from "@/lib/supabase";
import type { RoameoRules } from "@/lib/types";

/** Fetch the Roameo rules row for a device. Returns null if none exist yet. */
export async function getRules(deviceId: string): Promise<RoameoRules | null> {
  const { data, error } = await supabase
    .from("roameo_rules")
    .select("*")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Create or update the rules row for a device (device_id is the PK). */
export async function upsertRules(
  deviceId: string,
  patch: { rules_text?: string | null; quick_chips?: string[] }
): Promise<RoameoRules> {
  const { data, error } = await supabase
    .from("roameo_rules")
    .upsert({ device_id: deviceId, ...patch }, { onConflict: "device_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}
