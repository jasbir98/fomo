import "server-only";

/**
 * True when a caught error looks like a Supabase/PostgREST authorization
 * failure — insufficient privilege (`42501`) or an expired JWT (`PGRST301`)
 * — rather than a generic query failure (missing row, network blip, etc).
 *
 * Used by every user-scoped GET route (`/api/saved`, `/api/feed`,
 * `/api/alerts`, `/api/push/subscribe`) to tell "you're not allowed" apart
 * from "nothing here" — otherwise an auth denial renders identically to a
 * genuinely empty result.
 */
export function isUnauthorizedError(err: unknown): boolean {
  const code = (err as { code?: string } | null | undefined)?.code;
  return code === "42501" || code === "PGRST301";
}
