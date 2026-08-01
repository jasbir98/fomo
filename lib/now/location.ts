import { deleteDeviceLocation, upsertDeviceLocation } from "@/lib/db/location";
import { describeSupabaseError } from "@/lib/db/errors";

/** ~1.1km at the equator — coarse enough that this is a "which neighborhood are you in" signal, not tracking. See supabase/add_now_ranker_tables.sql. */
function roundCoarse(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Persist a coarse last-known location for graceful degradation (app
 * reopened, GPS still acquiring — see plan-v1-home-pivot.md §10.3). Callable
 * from the client: fire-and-forget after a successful useGeolocation() read.
 */
export async function rememberDeviceLocation(
  deviceId: string,
  lat: number,
  lng: number
): Promise<void> {
  try {
    await upsertDeviceLocation(deviceId, roundCoarse(lat), roundCoarse(lng));
  } catch (err) {
    console.error(`[roameo] rememberDeviceLocation failed ${describeSupabaseError(err)}`);
  }
}

/** Call when location permission is revoked/denied — this table must never outlive consent. */
export async function forgetDeviceLocation(deviceId: string): Promise<void> {
  try {
    await deleteDeviceLocation(deviceId);
  } catch (err) {
    console.error(`[roameo] forgetDeviceLocation failed ${describeSupabaseError(err)}`);
  }
}
