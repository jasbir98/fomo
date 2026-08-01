import { supabase } from "@/lib/supabase";
import type { Trip, TripInsert, TripUpdate } from "@/lib/types";
import { seedTokyoItineraryItems } from "@/lib/db/items";

const DEMO_TRIP_NAME = "Tokyo Spring Trip";

/** List all trips for a device, most recently created first. */
export async function listTrips(deviceId: string): Promise<Trip[]> {
  const { data, error } = await supabase
    .from("trips")
    .select("*")
    .eq("device_id", deviceId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** Fetch a single trip by id, scoped to the device. Returns null if not found. */
export async function getTrip(
  deviceId: string,
  id: string
): Promise<Trip | null> {
  const { data, error } = await supabase
    .from("trips")
    .select("*")
    .eq("device_id", deviceId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Create a new trip for a device. */
export async function createTrip(
  deviceId: string,
  patch: Omit<TripInsert, "device_id">
): Promise<Trip> {
  const { data, error } = await supabase
    .from("trips")
    .insert({ device_id: deviceId, ...patch })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/** Update a trip by id, scoped to the device. */
export async function updateTrip(
  deviceId: string,
  id: string,
  patch: TripUpdate
): Promise<Trip> {
  const { data, error } = await supabase
    .from("trips")
    .update(patch)
    .eq("device_id", deviceId)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Return the device's "current" trip: the most recent trip with
 * status "active" if one exists, else the most recently created trip.
 * Returns null if the device has no trips yet.
 */
export async function getCurrentTrip(deviceId: string): Promise<Trip | null> {
  const { data: active, error: activeError } = await supabase
    .from("trips")
    .select("*")
    .eq("device_id", deviceId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeError) throw activeError;
  if (active) return active;

  const { data: latest, error: latestError } = await supabase
    .from("trips")
    .select("*")
    .eq("device_id", deviceId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw latestError;
  return latest;
}

/**
 * Make one trip the device's active trip: set the chosen trip's status to
 * "active" and every other trip for the device to "inactive". Scoped to the
 * device, so it can't touch another device's trips. Used by the trip switcher
 * and the create-trip flow. `getCurrentTrip` reads back the "active" row.
 */
export async function setActiveTrip(
  deviceId: string,
  tripId: string
): Promise<void> {
  // Deactivate every other trip for this device first.
  const { error: deactivateError } = await supabase
    .from("trips")
    .update({ status: "inactive" })
    .eq("device_id", deviceId)
    .neq("id", tripId);
  if (deactivateError) throw deactivateError;

  // Then mark the chosen trip active.
  const { error: activateError } = await supabase
    .from("trips")
    .update({ status: "active" })
    .eq("device_id", deviceId)
    .eq("id", tripId);
  if (activateError) throw activateError;
}

/**
 * Delete a trip, scoped to the device. `itinerary_items` and `chat_messages`
 * cascade-delete via their FK (see schema.sql). If the deleted trip was the
 * device's active one and other trips remain, the most recently created
 * remaining trip becomes active so `getCurrentTrip` keeps resolving sensibly
 * — callers don't need to handle re-picking an active trip themselves.
 */
export async function deleteTrip(deviceId: string, tripId: string): Promise<void> {
  const { data: trip, error: fetchError } = await supabase
    .from("trips")
    .select("status")
    .eq("device_id", deviceId)
    .eq("id", tripId)
    .maybeSingle();
  if (fetchError) throw fetchError;
  const wasActive = trip?.status === "active";

  const { error: deleteError } = await supabase
    .from("trips")
    .delete()
    .eq("device_id", deviceId)
    .eq("id", tripId);
  if (deleteError) throw deleteError;

  if (!wasActive) return;

  const { data: remaining, error: remainingError } = await supabase
    .from("trips")
    .select("id")
    .eq("device_id", deviceId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (remainingError) throw remainingError;
  if (remaining) await setActiveTrip(deviceId, remaining.id);
}

/**
 * Idempotently seed the demo "Tokyo Spring Trip" for a device, along with
 * its ~4 itinerary items. If a trip with that name already exists for the
 * device, returns it as-is (no duplicate items are inserted). Otherwise
 * creates the trip + items and returns the new trip.
 */
export async function ensureDemoTrip(deviceId: string): Promise<Trip> {
  const { data: existing, error: existingError } = await supabase
    .from("trips")
    .select("*")
    .eq("device_id", deviceId)
    .eq("name", DEMO_TRIP_NAME)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing;

  const trip = await createTrip(deviceId, {
    name: DEMO_TRIP_NAME,
    destination: "Tokyo, Japan",
    start_date: "2026-03-28",
    end_date: "2026-04-11",
    status: "active",
    cover_image_url:
      "https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?w=1200&q=80",
  });

  await seedTokyoItineraryItems(deviceId, trip.id);

  return trip;
}
