/**
 * Server-only rate limiting for Fomo's paid/abuse-prone routes. Vercel
 * Hobby runs the app as multiple serverless instances with no shared
 * memory, so an in-process counter would silently under-count — everything
 * here calls a Postgres function instead, which does the atomic increment
 * in the database every instance shares.
 *
 * Two independent schemes, because they're scoped differently:
 *
 *   - `consumeRateLimit` — PER-USER, via `consume_rate_limit`
 *     (supabase/add_rate_limits.sql), scoped to `auth.uid()` inside the
 *     function itself. Only works for a signed-in caller (app/api/chat,
 *     app/api/translate).
 *   - `consumeAnonRateLimit` / `consumeGlobalRateLimit` — IP-scoped (or a
 *     fixed shared key) via `consume_anon_rate_limit`
 *     (supabase/add_anon_rate_limits.sql), for routes with no session at
 *     all (app/api/subscribe, app/api/tips) or a site-wide backstop
 *     (app/api/chat's global daily cap). See that pair's own doc comments
 *     below for the key derivation.
 *
 * FAIL-OPEN before either migration is applied: if the RPC doesn't exist
 * yet, PostgREST/Postgres report that as error code `PGRST202` (PostgREST:
 * no matching function in the schema cache) or `42883` (Postgres: undefined
 * function) — either one is treated as "rate limiting isn't wired up yet",
 * logs a `console.warn` (once per route for the anon path), and lets the
 * request through. Any OTHER RPC error (network blip, unexpected shape)
 * also fails open, on the same reasoning: a rate limiter must never be the
 * reason a route goes down entirely. Once a migration is applied, a real
 * "not allowed" result from its function fails CLOSED — that's the only
 * path that denies a request. This means the app is unprotected until the
 * owner runs the relevant .sql file by hand in the Supabase SQL editor —
 * expected and documented, not a bug.
 */
import "server-only";
import { createHash } from "node:crypto";
import type { Db } from "@/lib/supabase/types";
import { supabaseAdmin } from "@/lib/supabase/admin";

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

// ============================================================================
// ANONYMOUS / GLOBAL rate limiting — supabase/add_anon_rate_limits.sql's
// `consume_anon_rate_limit`. Used by routes with no session at all
// (app/api/subscribe, app/api/tips) and app/api/chat's site-wide daily cap.
// ============================================================================

export interface AnonRateLimitOptions {
  /** Max requests allowed within the window. */
  limit: number;
  /** Window width in seconds. */
  windowSeconds: number;
}

/** Error codes meaning "the consume_anon_rate_limit function doesn't exist yet" — supabase/add_anon_rate_limits.sql hasn't been run. Same codes as MISSING_FUNCTION_CODES above (PostgREST/Postgres report a missing function identically regardless of which one), kept as a separate constant since the two limiters are documented and reasoned about independently. */
const MISSING_ANON_FUNCTION_CODES = new Set(["PGRST202", "42883"]);

/** Logs the "migration not applied" warning at most once per route per process, so a busy anonymous route doesn't spam the server log on every single request while failing open. */
const warnedMissingAnonFunctionForRoute = new Set<string>();
function warnMissingAnonRateLimitOnce(route: string): void {
  if (warnedMissingAnonFunctionForRoute.has(route)) return;
  warnedMissingAnonFunctionForRoute.add(route);
  console.warn(
    `[rate-limit] consume_anon_rate_limit not found — supabase/add_anon_rate_limits.sql hasn't been run yet. Failing open for "${route}".`
  );
}

/**
 * First hop of X-Forwarded-For — the actual client IP as seen by Vercel's
 * edge, not any downstream proxy hop. Falls back to a constant "unknown"
 * bucket (shared by every request missing the header, e.g. local dev
 * without a proxy in front) rather than skipping the limit outright, so
 * stripping the header isn't a free bypass — it just means sharing one
 * bucket with everyone else who also has no header.
 */
function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

/**
 * SHA-256("<ip>:<salt>") — the table (supabase/add_anon_rate_limits.sql)
 * never stores a raw IP. Salted with `ANON_RATE_SALT` so the hash can't be
 * brute-forced back to an IPv4 address by just hashing all ~4 billion of
 * them (a bare, unsalted `sha256(ip)` would be trivially reversible that
 * way). Falls back to a constant derived from the service-role key when
 * `ANON_RATE_SALT` isn't set yet, so anon rate limiting still works (with a
 * weaker but still non-public secret) before that env var is added —
 * same "don't let the app be unprotected just because one env var is
 * missing" spirit as the fail-open behaviour above.
 */
function hashAnonKey(ip: string): string {
  const salt =
    process.env.ANON_RATE_SALT ||
    createHash("sha256")
      .update(`fomo-anon-rate-salt-fallback:${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`)
      .digest("hex");
  return createHash("sha256").update(`${ip}:${salt}`).digest("hex");
}

/**
 * Calls `consume_anon_rate_limit` with the given key/route/window/limit.
 * Shared by `consumeAnonRateLimit` (IP-derived key) and
 * `consumeGlobalRateLimit` (fixed key) below — both use the admin
 * (service-role) client since the function's EXECUTE grant is
 * service_role-only (see supabase/add_anon_rate_limits.sql); an
 * anon/authenticated caller could never invoke it directly even if it
 * tried, so this must run server-side with the service-role key, never via
 * a client-facing RPC call.
 */
async function callConsumeAnonRateLimit(
  key: string,
  route: string,
  { limit, windowSeconds }: AnonRateLimitOptions
): Promise<{ allowed: boolean }> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("consume_anon_rate_limit", {
    p_key: key,
    p_route: route,
    p_window_seconds: windowSeconds,
    p_max: limit,
  });

  if (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code && MISSING_ANON_FUNCTION_CODES.has(code)) {
      warnMissingAnonRateLimitOnce(route);
    } else {
      console.warn(`[rate-limit] consume_anon_rate_limit call failed for "${route}" — failing open.`, error);
    }
    return { allowed: true };
  }

  return { allowed: data === true };
}

/**
 * Anonymous, IP-scoped rate limit for routes with no session at all —
 * POST /api/subscribe and POST /api/tips. See hashAnonKey's doc comment
 * for why the IP itself is never stored.
 */
export async function consumeAnonRateLimit(
  request: Request,
  route: string,
  options: AnonRateLimitOptions
): Promise<{ allowed: boolean }> {
  const key = hashAnonKey(clientIp(request));
  return callConsumeAnonRateLimit(key, route, options);
}

/**
 * Site-wide rate limit shared by every caller regardless of identity —
 * app/api/chat's global daily cap, on top of its per-user limits. Reuses
 * `consume_anon_rate_limit`/`anon_rate_limits` with a fixed, non-secret key
 * ("global") rather than a new table: `route` alone already scopes this to
 * one counter, and "global" is never derived from or mixed with any
 * visitor's IP or identity.
 */
export async function consumeGlobalRateLimit(
  route: string,
  options: AnonRateLimitOptions
): Promise<{ allowed: boolean }> {
  return callConsumeAnonRateLimit("global", route, options);
}

/** Generic 429 for the anon/global limiter, whose underlying function returns only a boolean (no reset timestamp) — see supabase/add_anon_rate_limits.sql. `retryAfterSeconds` should be the caller's own window width as an upper-bound estimate. */
export function anonRateLimitedResponse(message: string, retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: "rate_limited", message }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "Retry-After": String(Math.max(1, Math.trunc(retryAfterSeconds))),
    },
  });
}
