/**
 * Server-only per-user rate limiting for Fomo's paid LLM routes
 * (app/api/chat, app/api/translate). Vercel Hobby runs the app as multiple
 * serverless instances with no shared memory, so an in-process counter
 * would silently under-count — this calls the `consume_rate_limit` Postgres
 * function (supabase/add_rate_limits.sql) instead, which does the atomic
 * increment in the database every instance shares.
 *
 * FAIL-OPEN before the migration is applied: if the RPC doesn't exist yet,
 * PostgREST/Postgres report that as error code `PGRST202` (PostgREST: no
 * matching function in the schema cache) or `42883` (Postgres: undefined
 * function) — either one is treated as "rate limiting isn't wired up yet",
 * logs a `console.warn`, and lets the request through. Any OTHER RPC error
 * (network blip, unexpected shape) also fails open, on the same reasoning
 * as the doc comment above: a rate limiter must never be the reason a paid
 * AI route goes down. Once the migration is applied, a real "not allowed"
 * result from the function fails CLOSED — that's the only path that denies
 * a request.
 */
import "server-only";
import type { Db } from "@/lib/supabase/types";

export interface RateLimitOptions {
  /** Max requests allowed within the window. */
  limit: number;
  /** Window width in seconds. */
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** ISO timestamp the current window resets at, or null when this is a fail-open default (no real check ran). */
  resetAt: string | null;
}

/** Error codes meaning "the consume_rate_limit function doesn't exist yet" — the migration hasn't been run. */
const MISSING_FUNCTION_CODES = new Set(["PGRST202", "42883"]);

/**
 * Consumes one request against a single fixed window for `route`, scoped to
 * the signed-in user carried by `db`'s session. Call once per window a
 * route wants to enforce (e.g. a burst window and a daily window use two
 * calls with distinct `route` strings — see app/api/chat/route.ts) since
 * `consume_rate_limit` tracks exactly one window per (user, route) pair.
 */
export async function consumeRateLimit(
  db: Db,
  route: string,
  { limit, windowSeconds }: RateLimitOptions
): Promise<RateLimitResult> {
  const { data, error } = await db.rpc("consume_rate_limit", {
    p_route: route,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code && MISSING_FUNCTION_CODES.has(code)) {
      console.warn(
        `[rate-limit] consume_rate_limit not found (code ${code}) — supabase/add_rate_limits.sql hasn't been run yet. Failing open for "${route}".`
      );
    } else {
      console.warn(`[rate-limit] consume_rate_limit call failed for "${route}" — failing open.`, error);
    }
    return { allowed: true, remaining: limit, resetAt: null };
  }

  // supabase-js returns RETURNS TABLE results as an array of rows.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { allowed?: unknown; remaining?: unknown; reset_at?: unknown }
    | null
    | undefined;
  if (!row) return { allowed: true, remaining: limit, resetAt: null };

  return {
    allowed: Boolean(row.allowed),
    remaining: typeof row.remaining === "number" ? row.remaining : 0,
    resetAt: typeof row.reset_at === "string" ? row.reset_at : null,
  };
}

/** Minutes-from-now, rounded up, for a friendly "try again in N minutes" message. */
function minutesUntil(resetAt: string | null): number {
  if (!resetAt) return 1;
  const ms = new Date(resetAt).getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 60_000));
}

/** Seconds-from-now, rounded up, for the `Retry-After` header. */
function secondsUntil(resetAt: string | null): number {
  if (!resetAt) return 60;
  const ms = new Date(resetAt).getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Standard 429 response for a denied `RateLimitResult` — same JSON shape
 * and `Retry-After` header for both app/api/chat and app/api/translate so
 * the client-side handling in app/(shell)/fomo/page.tsx and
 * app/fomo/translator/page.tsx can share one code path.
 */
export function rateLimitedResponse(result: RateLimitResult): Response {
  const minutes = minutesUntil(result.resetAt);
  const message = `You've hit the limit for now — try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  return new Response(
    JSON.stringify({ error: "rate_limited", message, resetAt: result.resetAt }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "Retry-After": String(secondsUntil(result.resetAt)),
      },
    }
  );
}
