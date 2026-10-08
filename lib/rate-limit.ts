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
 *     (supabase/archive/add_rate_limits.sql), scoped to `auth.uid()` inside the
 *     function itself. Only works for a signed-in caller (app/api/chat).
 *   - `consumeAnonRateLimit` / `consumeGlobalRateLimit` — IP-scoped (or a
 *     fixed shared key) via `consume_anon_rate_limit`
 *     (supabase/archive/add_anon_rate_limits.sql), for routes with no session at
 *     all (app/api/subscribe, app/api/tips) or a site-wide backstop
 *     (app/api/chat's global daily cap). See that pair's own doc comments
 *     below for the key derivation.
 *
 * FAIL-OPEN by default: if the RPC doesn't exist, PostgREST/Postgres report
 * that as error code `PGRST202` (PostgREST: no matching function in the
 * schema cache) or `42883` (Postgres: undefined function) — either one is
 * treated as "rate limiting isn't wired up yet", logs a `console.warn`
 * (once per route for the anon path), and lets the request through. Any
 * OTHER RPC error (network blip, unexpected shape) also fails open, on the
 * same reasoning: a rate limiter must never be the reason a route goes down
 * entirely. Once a migration is applied, a real "not allowed" result from
 * its function fails CLOSED regardless of this setting — that's the
 * everyday path that denies a request. This means the app is unprotected
 * against RPC errors until the owner runs the relevant .sql file by hand in
 * the Supabase SQL editor — expected and documented, not a bug.
 *
 * OPT-IN FAIL-CLOSED: every `consume*` function takes an optional
 * `failClosed` (default `false`). When `true`, an RPC error denies the
 * request (the normal 429 "busy" response) instead of letting it through.
 * app/api/chat/route.ts is the one caller that sets this, and only in
 * production (`NODE_ENV === "production"`) — chat calls a paid LLM per
 * request, so once the migration is confirmed applied in prod (it is, as of
 * this change), an RPC error there should deny rather than risk unbounded
 * spend. subscribe/tips (`consumeAnonRateLimit`) and every non-production
 * environment keep the original fail-open default.
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
  /** When true, an RPC error denies the request instead of failing open — see the module doc comment. Default false. */
  failClosed?: boolean;
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
  { limit, windowSeconds, failClosed = false }: RateLimitOptions
): Promise<RateLimitResult> {
  const { data, error } = await db.rpc("consume_rate_limit", {
    p_route: route,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    const code = (error as { code?: string } | null)?.code;
    const verdict = failClosed ? "closed" : "open";
    if (code && MISSING_FUNCTION_CODES.has(code)) {
      console.warn(
        `[rate-limit] consume_rate_limit not found (code ${code}) — supabase/archive/add_rate_limits.sql hasn't been run yet. Failing ${verdict} for "${route}".`
      );
    } else {
      console.warn(`[rate-limit] consume_rate_limit call failed for "${route}" — failing ${verdict}.`, error);
    }
    if (failClosed) return { allowed: false, remaining: 0, resetAt: null };
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
 * and `Retry-After` header app/api/chat always returns, so the client-side
 * handling in app/(shell)/fomo/page.tsx has one shape to parse.
 */
export function rateLimitedResponse(result: RateLimitResult): Response {
  const minutes = minutesUntil(result.resetAt);
  const message = `You've hit the limit for now. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
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

/**
 * How many of a signed-in user's slots for `route` they've used in the
 * current fixed window, without consuming one: for the chat screen's
 * "N questions left" line. Reads api_rate_limits with the service role (the
 * table has no select policy); window start mirrors consume_rate_limit's
 * floor exactly. Returns 0 on any failure (display only).
 */
export async function peekRateLimit(userId: string, route: string, windowSeconds: number): Promise<number> {
  try {
    const windowStart = new Date(Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds * 1000).toISOString();
    const { data } = await supabaseAdmin()
      .from("api_rate_limits")
      .select("count")
      .eq("user_id", userId)
      .eq("route", route)
      .eq("window_start", windowStart)
      .maybeSingle();
    return (data as { count?: number } | null)?.count ?? 0;
  } catch (err) {
    console.warn(`[rate-limit] peek failed for "${route}"`, err);
    return 0;
  }
}

// ============================================================================
// ANONYMOUS / GLOBAL rate limiting — supabase/archive/add_anon_rate_limits.sql's
// `consume_anon_rate_limit`. Used by routes with no session at all
// (app/api/subscribe, app/api/tips) and app/api/chat's site-wide daily cap.
// ============================================================================

export interface AnonRateLimitOptions {
  /** Max requests allowed within the window. */
  limit: number;
  /** Window width in seconds. */
  windowSeconds: number;
  /** When true, an RPC error denies the request instead of failing open — see the module doc comment. Default false. Only app/api/chat's `consumeGlobalRateLimit` call sets this (in production); `consumeAnonRateLimit` (subscribe/tips) never does. */
  failClosed?: boolean;
}

/** Error codes meaning "the consume_anon_rate_limit function doesn't exist yet" — supabase/archive/add_anon_rate_limits.sql hasn't been run. Same codes as MISSING_FUNCTION_CODES above (PostgREST/Postgres report a missing function identically regardless of which one), kept as a separate constant since the two limiters are documented and reasoned about independently. */
const MISSING_ANON_FUNCTION_CODES = new Set(["PGRST202", "42883"]);

/** Logs the "migration not applied" warning at most once per route per process, so a busy anonymous route doesn't spam the server log on every single request while failing open (or closed). */
const warnedMissingAnonFunctionForRoute = new Set<string>();
function warnMissingAnonRateLimitOnce(route: string, failClosed: boolean): void {
  if (warnedMissingAnonFunctionForRoute.has(route)) return;
  warnedMissingAnonFunctionForRoute.add(route);
  console.warn(
    `[rate-limit] consume_anon_rate_limit not found — supabase/archive/add_anon_rate_limits.sql hasn't been run yet. Failing ${failClosed ? "closed" : "open"} for "${route}".`
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
 * SHA-256("<ip>:<salt>") — the table (supabase/archive/add_anon_rate_limits.sql)
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
 * service_role-only (see supabase/archive/add_anon_rate_limits.sql); an
 * anon/authenticated caller could never invoke it directly even if it
 * tried, so this must run server-side with the service-role key, never via
 * a client-facing RPC call.
 */
async function callConsumeAnonRateLimit(
  key: string,
  route: string,
  { limit, windowSeconds, failClosed = false }: AnonRateLimitOptions
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
      warnMissingAnonRateLimitOnce(route, failClosed);
    } else {
      console.warn(`[rate-limit] consume_anon_rate_limit call failed for "${route}" — failing ${failClosed ? "closed" : "open"}.`, error);
    }
    return { allowed: !failClosed };
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
 * Reads this caller's row for the current fixed window of an anonymous
 * IP-scoped limit, or count 0 when there's no row yet. Window start mirrors
 * consume_anon_rate_limit's floor exactly, so it addresses the same row.
 * Shared by `peekAnonRateLimit` and `refundAnonRateLimit`.
 */
async function readAnonWindow(
  request: Request,
  route: string,
  windowSeconds: number
): Promise<{ key: string; windowStart: string; count: number }> {
  const key = hashAnonKey(clientIp(request));
  const windowStart = new Date(Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds * 1000).toISOString();
  const { data } = await supabaseAdmin()
    .from("anon_rate_limits")
    .select("count")
    .eq("key", key)
    .eq("route", route)
    .eq("window_start", windowStart)
    .maybeSingle();
  return { key, windowStart, count: (data as { count?: number } | null)?.count ?? 0 };
}

/**
 * How many of an anonymous IP-scoped limit's slots this caller has used in
 * the current window, without consuming one — for showing "N free questions
 * left". Returns 0 when there's no row or the read fails (display only; the
 * consume call is what actually enforces the limit).
 */
export async function peekAnonRateLimit(request: Request, route: string, windowSeconds: number): Promise<number> {
  try {
    return (await readAnonWindow(request, route, windowSeconds)).count;
  } catch (err) {
    console.warn(`[rate-limit] peek failed for "${route}"`, err);
    return 0;
  }
}

/**
 * Gives back one unit of an anonymous IP-scoped limit — for a request that
 * consumed a slot but then failed on our side (e.g. the AI call errored), so
 * a signed-out visitor's handful of free questions isn't eaten by our own
 * failures. Best effort: read-then-write rather than an atomic RPC (a race
 * can only under-refund), and any error is swallowed.
 */
export async function refundAnonRateLimit(request: Request, route: string, windowSeconds: number): Promise<void> {
  try {
    const { key, windowStart, count } = await readAnonWindow(request, route, windowSeconds);
    if (count <= 0) return;
    await supabaseAdmin()
      .from("anon_rate_limits")
      .update({ count: count - 1 })
      .eq("key", key)
      .eq("route", route)
      .eq("window_start", windowStart)
      .eq("count", count);
  } catch (err) {
    console.warn(`[rate-limit] refund failed for "${route}"`, err);
  }
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

/** Generic 429 for the anon/global limiter, whose underlying function returns only a boolean (no reset timestamp) — see supabase/archive/add_anon_rate_limits.sql. `retryAfterSeconds` should be the caller's own window width as an upper-bound estimate. */
export function anonRateLimitedResponse(message: string, retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: "rate_limited", message }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "Retry-After": String(Math.max(1, Math.trunc(retryAfterSeconds))),
    },
  });
}
