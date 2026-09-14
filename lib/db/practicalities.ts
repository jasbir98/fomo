import type { Db } from "@/lib/supabase/types";
import type { CountryPracticality, PracticalityTopic } from "@/lib/types";

/**
 * Days between the trip's `start_date` and `now`, signed — negative before
 * the trip starts, 0 on the start date, positive after. Day-granularity
 * (not hours), matching `country_practicalities.applies_from_days/to_days`
 * (plan-v1.2-accounts.md §E.1: "applies_hours_from/to becomes
 * applies_from_days/to_days at day granularity"). No `start_date` on the
 * trip (pre-Phase-3 trips, or a trip created without dates) resolves to 0 —
 * "today", the most permissive default, so a missing date degrades toward
 * showing practicalities rather than hiding them.
 */
function daysFromTripStart(tripStartDate: string | null, now: Date): number {
  if (!tripStartDate) return 0;
  const start = new Date(`${tripStartDate}T00:00:00Z`);
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((today.getTime() - start.getTime()) / 86_400_000);
}

/** Topics the signed-in caller has already dismissed for this country (any trip — see practicality_dismissals' own (user, country, topic) key doc comment, lib/types.ts). RLS scopes this to the caller's own rows. */
export async function listDismissedTopics(db: Db, countryCode: string): Promise<PracticalityTopic[]> {
  const { data, error } = await db
    .from("practicality_dismissals")
    .select("topic")
    .eq("country_code", countryCode);
  if (error) throw error;
  return (data ?? []).map((row) => row.topic as PracticalityTopic);
}

/** Dismiss one topic for the signed-in caller + country — "Already sorted". Upserts on the (user_id, country_code, topic) primary key, so tapping it twice is a no-op, not an error. user_id is filled by the `default auth.uid()` column default, same convention as saveItem (lib/db/saved.ts). */
export async function dismissTopic(db: Db, countryCode: string, topic: PracticalityTopic): Promise<void> {
  const { error } = await db
    .from("practicality_dismissals")
    .upsert({ country_code: countryCode, topic }, { onConflict: "user_id,country_code,topic" });
  if (error) throw error;
}

/**
 * Clear every dismissed-practicality-topic row for the signed-in caller —
 * "Reset practicalities" on Profile (plan §E.1, flagged as a Phase 7
 * follow-up and picked up in Phase 8 cleanup). Deliberately no country/topic
 * filter: this resets every dismissal across every country the caller has
 * ever traveled to, not just the current trip's. No `.eq(...)` needed —
 * `practicality_dismissals`' `own_rows` RLS policy (supabase/add_practicalities.sql)
 * is what actually restricts the delete to the caller's own rows. The
 * always-true `.not(...)` only satisfies the database's safe-update check,
 * which rejects a DELETE with no WHERE clause (code 21000) — same convention
 * as `lib/db/location.ts`'s `deleteUserLocation`.
 */
export async function resetAllDismissals(db: Db): Promise<void> {
  const { error } = await db.from("practicality_dismissals").delete().not("user_id", "is", null);
  if (error) throw error;
}

/**
 * The practicality rows relevant right now for one country (+ optional
 * city), already excluding dismissed topics and sorted highest-priority
 * first — everything lib/now/context.ts's `buildRankContext` needs in one
 * call, so it can sit inside that function's existing `Promise.all` rather
 * than adding a second sequential fetch (plan §E.2).
 *
 * Two internal queries (rows + dismissals) run in parallel via `Promise.all`
 * rather than depending on each other — this is still "one call" from the
 * caller's perspective, it just doesn't block behind two sequential
 * round-trips of its own.
 *
 * Date-window filter: a row applies when
 * `row.applies_from_days <= daysFromTripStart <= row.applies_to_days`. E.g.
 * a JP trip 5 days out (`daysFromTripStart === -5`) with the default
 * `applies_from_days -14 / applies_to_days 3` window matches (`-14 <= -5 <=
 * 3`), so every default-window topic (connectivity/money/transit/power/
 * tipping/water) returns; a hypothetical row scoped to `applies_from_days 10`
 * (something only relevant a week+ into the trip) would NOT match yet and is
 * correctly excluded.
 *
 * City-scope preference: when both a country-wide row (`city: null`) and a
 * city-specific row exist for the same topic, the city-specific one wins —
 * same precedence lib/db/arrivalTips.ts's (now-retired) `getArrivalTip`
 * used.
 */
export async function listPracticalities(
  db: Db,
  countryCode: string,
  city: string | null,
  tripStartDate: string | null,
  now: Date = new Date()
): Promise<CountryPracticality[]> {
  const [rowsResult, dismissed] = await Promise.all([
    db.from("country_practicalities").select("*").eq("country_code", countryCode),
    listDismissedTopics(db, countryCode),
  ]);
  if (rowsResult.error) throw rowsResult.error;

  const dismissedTopics = new Set(dismissed);
  const offset = daysFromTripStart(tripStartDate, now);

  const inWindow = (rowsResult.data ?? []).filter(
    (row) =>
      !dismissedTopics.has(row.topic as PracticalityTopic) &&
      row.applies_from_days <= offset &&
      offset <= row.applies_to_days
  );

  const byTopic = new Map<string, CountryPracticality>();
  for (const row of inWindow) {
    const existing = byTopic.get(row.topic);
    if (!existing) {
      byTopic.set(row.topic, row);
      continue;
    }
    const rowIsCityMatch = city != null && row.city === city;
    const existingIsCityMatch = city != null && existing.city === city;
    if (rowIsCityMatch && !existingIsCityMatch) byTopic.set(row.topic, row);
  }

  return [...byTopic.values()].sort((a, b) => b.priority - a.priority);
}
