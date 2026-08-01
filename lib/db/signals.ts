import { supabase } from "@/lib/supabase";
import { describeSupabaseError } from "@/lib/db/errors";
import type { CardSignal, CardSignalInsert } from "@/lib/types";

/**
 * Record a card lifecycle event (shown/opened/dismissed/saved/planned). Never
 * throws to the caller on failure — signal-writing is a side effect of
 * rendering/interacting with a card, and a failed write must not break the
 * card itself. Fire-and-forget from the UI: `void recordCardSignal(...)`.
 */
export async function recordCardSignal(patch: CardSignalInsert): Promise<void> {
  const { error } = await supabase.from("card_signals").insert(patch);
  if (error) console.error(`[roameo] recordCardSignal failed ${describeSupabaseError(error)}`);
}

/**
 * Recent signals for a device, most recent first. Used by the ranker's
 * noveltyDecay (a card shown/dismissed recently scores lower) and by
 * prefFit's interest-learning (repeated saves/plans of a category).
 */
export async function listRecentSignals(
  deviceId: string,
  sinceHoursAgo = 72
): Promise<CardSignal[]> {
  const since = new Date(Date.now() - sinceHoursAgo * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("card_signals")
    .select("*")
    .eq("device_id", deviceId)
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}
