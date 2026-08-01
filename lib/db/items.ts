import { supabase } from "@/lib/supabase";
import type {
  ItineraryItem,
  ItineraryItemInsert,
  ItineraryItemUpdate,
} from "@/lib/types";

/** List all itinerary items for a trip, scoped to the device, earliest day first. */
export async function listItems(
  deviceId: string,
  tripId: string
): Promise<ItineraryItem[]> {
  const { data, error } = await supabase
    .from("itinerary_items")
    .select("*")
    .eq("device_id", deviceId)
    .eq("trip_id", tripId)
    .order("day_date", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** List itinerary items for a trip on a specific day, scoped to the device. */
export async function listItemsByDay(
  deviceId: string,
  tripId: string,
  dayDate: string
): Promise<ItineraryItem[]> {
  const { data, error } = await supabase
    .from("itinerary_items")
    .select("*")
    .eq("device_id", deviceId)
    .eq("trip_id", tripId)
    .eq("day_date", dayDate)
    .order("time_label", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Fetch a single itinerary item by id, scoped to the device. */
export async function getItem(
  deviceId: string,
  id: string
): Promise<ItineraryItem | null> {
  const { data, error } = await supabase
    .from("itinerary_items")
    .select("*")
    .eq("device_id", deviceId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Create a new itinerary item for a device+trip, deduping against an
 * existing item with the same trip + title + day_date. The chat screen can
 * call this repeatedly for the same AI-proposed card/proposal (e.g. after a
 * reload where "already added" state was re-derived) — without this guard
 * that would silently insert a duplicate `itinerary_items` row each time.
 * Returns the existing row instead of inserting when one matches.
 */
export async function createItem(
  deviceId: string,
  patch: Omit<ItineraryItemInsert, "device_id">
): Promise<ItineraryItem> {
  if (patch.title && patch.trip_id) {
    let dedupeQuery = supabase
      .from("itinerary_items")
      .select("*")
      .eq("device_id", deviceId)
      .eq("trip_id", patch.trip_id)
      .eq("title", patch.title);
    dedupeQuery = patch.day_date
      ? dedupeQuery.eq("day_date", patch.day_date)
      : dedupeQuery.is("day_date", null);
    const { data: existing, error: findError } = await dedupeQuery.maybeSingle();
    if (findError) throw findError;
    if (existing) return existing;
  }

  const { data, error } = await supabase
    .from("itinerary_items")
    .insert({ device_id: deviceId, ...patch })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/** Update an itinerary item by id, scoped to the device. */
export async function updateItem(
  deviceId: string,
  id: string,
  patch: ItineraryItemUpdate
): Promise<ItineraryItem> {
  const { data, error } = await supabase
    .from("itinerary_items")
    .update(patch)
    .eq("device_id", deviceId)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/** Delete an itinerary item by id, scoped to the device. */
export async function deleteItem(
  deviceId: string,
  id: string
): Promise<void> {
  const { error } = await supabase
    .from("itinerary_items")
    .delete()
    .eq("device_id", deviceId)
    .eq("id", id);
  if (error) throw error;
}

/**
 * Internal seed helper used by ensureDemoTrip (lib/db/trips.ts) to populate
 * the demo "Tokyo Spring Trip" with its ~4 timeline items. Not idempotent on
 * its own — callers must only invoke this once per new trip.
 */
export async function seedTokyoItineraryItems(
  deviceId: string,
  tripId: string
): Promise<ItineraryItem[]> {
  const items: Omit<ItineraryItemInsert, "device_id" | "trip_id">[] = [
    {
      day_date: "2026-03-29",
      time_label: "7:00 AM",
      category: "activity",
      title: "Fushimi Inari Hike",
      location: "Fushimi Inari Taisha, Kyoto",
      weather_alert: false,
      color_tag: "green",
    },
    {
      day_date: "2026-03-29",
      time_label: "12:30 PM",
      category: "dining",
      title: "Nishiki Market Lunch",
      location: "Nishiki Market, Kyoto",
      weather_alert: false,
      color_tag: "orange",
    },
    {
      day_date: "2026-03-30",
      time_label: "9:00 AM",
      category: "activity",
      title: "Arashiyama Bamboo Walk",
      location: "Arashiyama Bamboo Grove, Kyoto",
      weather_alert: true,
      color_tag: "blue",
    },
    {
      day_date: "2026-03-30",
      time_label: "7:00 PM",
      category: "dining",
      title: "Kaiseki Dinner",
      location: "Gion, Kyoto",
      weather_alert: false,
      color_tag: "orange",
    },
  ];

  const { data, error } = await supabase
    .from("itinerary_items")
    .insert(
      items.map((item) => ({ device_id: deviceId, trip_id: tripId, ...item }))
    )
    .select("*");
  if (error) throw error;
  return data ?? [];
}
