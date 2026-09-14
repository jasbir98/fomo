/**
 * Canonical "city name" extraction from a free-text destination string —
 * the first comma-segment, trimmed (e.g. "Kyoto, Japan" -> "Kyoto").
 *
 * This exact logic was duplicated across `cityGuess()` in
 * lib/now/context.ts and lib/now/generators.ts, `cityName()` in
 * lib/now/rails.ts, the inline `cityGuess` in app/api/places/route.ts, and
 * `defaultTripName()` in app/onboarding/page.tsx and
 * app/plan/new-trip/page.tsx (plan-v1.2-accounts.md Phase 3 §B.1). This is
 * the one canonical implementation going forward — `trips.place_label`
 * (see supabase/add_trip_persona.sql) is the persisted output of this
 * function for a trip's `destination` at creation time.
 *
 * Not all five duplicate call sites have been pointed at this helper yet
 * (some read `trip.destination` at query time and would need a larger
 * refactor to read `trip.place_label` instead) — see the Phase 3 report for
 * which were left alone and why. New code should import this instead of
 * re-deriving the split.
 *
 * No `server-only` here on purpose: this is pure string logic used from
 * both server routes/lib modules and client components (e.g.
 * app/plan/new-trip/page.tsx computes a fallback label client-side too).
 */
export function placeLabel(destination: string | null | undefined): string | null {
  return destination?.split(",")[0]?.trim() || null;
}
