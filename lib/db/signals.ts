import type { Db } from "@/lib/supabase/types";
import { describeSupabaseError } from "@/lib/db/errors";
import type { CardSignal, CardSignalInsert } from "@/lib/types";

/**
 * Record a card lifecycle event (shown/opened/dismissed/saved/planned). Never
 * throws to the caller on failure — signal-writing is a side effect of
 * rendering/interacting with a card, and a failed write must not break the
 * card itself. Fire-and-forget from the UI: `void recordCardSignal(...)`.
 */
export async function recordCardSignal(db: Db, patch: CardSignalInsert): Promise<void> {
  // trip_id is always written null — Fomo has no trips anymore; the column
  // stays in the DB, unused.
  const { error } = await db.from("card_signals").insert({ ...patch, trip_id: null });
  if (error) console.error(`[fomo] recordCardSignal failed ${describeSupabaseError(error)}`);
}

/**
 * Recent signals for the signed-in caller, most recent first. Used by the
 * ranker's noveltyDecay (a card shown/dismissed recently scores lower) and
 * by prefFit's interest-learning (repeated saves/plans of a category).
 */
export async function listRecentSignals(db: Db, sinceHoursAgo = 72): Promise<CardSignal[]> {
  const since = new Date(Date.now() - sinceHoursAgo * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("card_signals")
    .select("*")
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}
