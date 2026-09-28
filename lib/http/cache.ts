import "server-only";
import { NextResponse } from "next/server";

/**
 * Shared `Cache-Control` presets for `app/api/**` route handlers.
 *
 * ALL PRESETS BELOW ARE `private` — NEVER `public`/`s-maxage`. This is not
 * an arbitrary conservatism; it's a direct consequence of `proxy.ts`
 * (repo root), which runs on every `/api/*` request:
 *
 *   - Its matcher covers every `/api/*` path (only static assets are
 *     excluded — see its `config.matcher`).
 *   - It calls `supabase.auth.getUser()` on every request, which makes
 *     `@supabase/ssr` transparently refresh a near-expiry session and write
 *     the new auth cookie via `setAll` onto the `NextResponse` the proxy
 *     builds (`proxy.ts`'s `response` variable).
 *   - For an authenticated `/api/*` call it does `return response` —
 *     handing that same (possibly cookie-bearing) response down the chain.
 *   - Next.js's own request pipeline (see `patchSetHeaderWithCookieSupport`
 *     in `next/dist/server/lib/patch-set-header.js`, wired up in
 *     `base-server.js` with the comment "ensure cookies set in middleware
 *     are merged and not overridden by API routes") then FORCIBLY re-injects
 *     that middleware `Set-Cookie` into whatever the route handler itself
 *     returns — a route handler cannot opt out of this by editing its own
 *     `Response` object; the merge happens at the framework level, after
 *     the handler runs.
 *
 * So any `/api/*` response can carry a live session's `Set-Cookie` header,
 * on a request that (per `proxy.ts`) only ever happens with a signed-in
 * session in the first place. If such a response were ever marked
 * `public`/`s-maxage`, Vercel's shared edge cache would store — and later
 * replay to a *different* visitor hitting the same cache key (e.g. the same
 * `/api/weather?destination=London`) — the first user's session cookie.
 * That's a full account-takeover vector, not a theoretical one.
 *
 * `private` tells every shared cache (CDN edge, corporate proxies) to never
 * store the response at all, while still letting the *requesting browser's*
 * own cache serve it again from disk — which is where most of the mobile
 * win here actually comes from (back-navigation, re-opening the app,
 * re-rendering the same feed), without needing a shared cache at all.
 *
 * If you're tempted to change one of these back to `public` to get edge
 * caching: don't, unless `proxy.ts`'s cookie-refresh behavior has changed
 * AND you've confirmed (by reading the current Next.js internals, not by
 * assumption) that a route handler can actually strip a middleware-injected
 * `Set-Cookie` before the response is sent. As of this writing it cannot.
 */

/** Rapidly-changing data (short TTL, quick recovery from a bad response). Browser-cache only — see file header. */
export const CACHE_SHORT = "private, max-age=60, stale-while-revalidate=300";

/** Third-party catalogue data (events, places) — minutes-scale staleness is fine. Browser-cache only — see file header. */
export const CACHE_MEDIUM = "private, max-age=300, stale-while-revalidate=1800";

/** Slow-changing data (weather forecasts). Browser-cache only — see file header. */
export const CACHE_LONG = "private, max-age=600, stale-while-revalidate=3600";

/** Effectively-immutable lookups (geocoding, proxied media bytes keyed on a stable query param). Browser-cache only — see file header. */
export const CACHE_IMMUTABLE = "private, max-age=86400, stale-while-revalidate=604800";

/**
 * Per-user / auth-gated GET responses. Explicit `private, no-store` so no
 * intermediary (CDN, proxy, browser disk cache) ever stores a response that
 * could differ per session.
 */
export const CACHE_PRIVATE_NO_STORE = "private, no-store";

/** `NextResponse.json` with a `Cache-Control` header attached. */
export function cachedJson<T>(data: T, cacheControl: string, init?: ResponseInit): NextResponse<T> {
  const res = NextResponse.json<T>(data, init);
  res.headers.set("Cache-Control", cacheControl);
  return res;
}

