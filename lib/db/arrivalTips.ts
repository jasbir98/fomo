import { supabase } from "@/lib/supabase";
import type { ArrivalTip } from "@/lib/types";

/**
 * The best-matching cold-start arrival tip for a country (+ optional city)
 * and hours-since-trip-start, or null if the pipeline has no coverage
 * (v1 only seeds JP and GB — see supabase/seed_arrival_tips.sql). City-scoped
 * rows are preferred over country-wide rows when both match.
 */
export async function getArrivalTip(
  country: string,
  city: string | null,
  hoursSinceArrival: number
): Promise<ArrivalTip | null> {
  const { data, error } = await supabase
    .from("arrival_tips")
    .select("*")
    .eq("country", country)
    .lte("applies_hours_from", hoursSinceArrival)
    .gte("applies_hours_to", hoursSinceArrival);
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return null;
  const cityMatch = city ? rows.find((r) => r.city === city) : undefined;
  return cityMatch ?? rows.find((r) => r.city == null) ?? rows[0];
}
