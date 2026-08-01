import { supabase } from "@/lib/supabase";
import type { DeviceLocation } from "@/lib/types";

/** Raw CRUD on `device_location`. Callers (lib/now/location.ts) own the
 * coarsening (rounding) and permission-revoked deletion policy — this module
 * just persists whatever it's given. */

export async function getDeviceLocation(deviceId: string): Promise<DeviceLocation | null> {
  const { data, error } = await supabase
    .from("device_location")
    .select("*")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertDeviceLocation(
  deviceId: string,
  lat: number,
  lng: number
): Promise<void> {
  const { error } = await supabase
    .from("device_location")
    .upsert(
      { device_id: deviceId, lat, lng, updated_at: new Date().toISOString() },
      { onConflict: "device_id" }
    );
  if (error) throw error;
}

export async function deleteDeviceLocation(deviceId: string): Promise<void> {
  const { error } = await supabase.from("device_location").delete().eq("device_id", deviceId);
  if (error) throw error;
}
