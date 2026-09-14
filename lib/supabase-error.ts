import "server-only";

/**
 * True when a caught error looks like a Supabase/PostgREST authorization
 * failure — insufficient privilege (`42501`) or an expired JWT (`PGRST301`)
 * — rather than a generic query failure (missing row, network blip, etc).
 *
 * Prep for the auth cutover (plan-v1.2-accounts.md §A.7): no auth system
 * exists yet, so this can't actually fire today, but the device-scoped
 * routes (`/api/now`, `/api/now/day`, `/api/now/draft-day`, `/api/discover`,
 * `/api/saved`) need to tell "you're not allowed" apart from "nothing here"
 * before RLS starts denying anonymous access — otherwise an auth denial
 * renders identically to an empty city.
 */
export function isUnauthorizedError(err: unknown): boolean {
  const code = (err as { code?: string } | null | undefined)?.code;
  return code === "42501" || code === "PGRST301";
}
