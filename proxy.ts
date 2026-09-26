import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/auth/safe-next";

/**
 * Open browsing, account-only actions. This proxy both refreshes the Supabase
 * session cookie AND gates account pages and costly APIs:
 *
 *   1. refresh session cookies (see footgun #1)
 *   2. read the user (see footgun #2)
 *   3. /api/*        → no user? 401 JSON, never a redirect — except the
 *                      read-only catalogue APIs in PUBLIC_API_PREFIXES
 *      passive-public (/welcome, /auth/callback, /offline) → always pass
 *      no user        → public pages pass; account pages (SIGNED_IN_PAGE_PREFIXES)
 *                      302 /welcome?next=... (unless already on /signin)
 *      user, on /signin or under the retired /onboarding → 302 ?next or /
 *
 * Two documented footguns, both worth re-reading before touching this file:
 *
 * 1. COOKIE PROPAGATION. `@supabase/ssr`'s cookie handlers write refreshed
 *    auth cookies onto a specific `NextResponse` instance (`response`
 *    below) as a side effect of `setAll`. Redirect and 401 responses in
 *    this file are constructed *after* that — each one is a fresh
 *    `NextResponse` that does NOT carry those cookies automatically, so
 *    every redirect/401 constructed below explicitly copies `response`'s
 *    cookies onto itself via `withCookies()`. Skipping that on any branch
 *    means the browser keeps a stale cookie, which on the redirect branches
 *    is exactly the infinite-redirect-loop footgun the plan warns about
 *    twice (a stale/expired session cookie never advances, so the next
 *    request re-triggers the same "no user" redirect forever).
 *
 * 2. `getUser()` IS A NETWORK HOP. It calls the Supabase Auth server on
 *    every request that hits this proxy. The documented faster path
 *    is `auth.getClaims()`, which verifies the JWT locally — but that only
 *    works once asymmetric (ECC P-256) JWT signing keys are enabled for
 *    this project in the Supabase Dashboard (Settings → API → JWT Keys).
 *    That's a manual dashboard step this code can't perform, and until
 *    it's confirmed done, `getClaims()` would silently fail closed. Using
 *    `getUser()` here on purpose; switch to `getClaims()` once the
 *    dashboard setting is enabled and verified.
 *
 * NO ONBOARDING GATE. The trip-era onboarding flow (app/onboarding/*) was
 * removed in the Fomo pivot, so `user_metadata.onboarded_at` is no longer
 * read here — a signed-in user goes straight to the page they asked for.
 *
 * WELCOME VS SIGNIN. Proxy has no visibility into localStorage (it
 * runs at the edge), so it can't itself tell "first visit" from "seen the
 * intro already" — that check lives client-side in app/welcome/page.tsx
 * (localStorage `fomo_seen_intro`), which self-redirects to `/signin` the
 * instant it mounts for a repeat visitor. Proxy therefore always sends
 * a signed-out visitor to `/welcome?next=...` (never straight to /signin),
 * and treats `/welcome` as a passive-public page that's fine to view in any
 * auth state rather than something to bounce a signed-in user away from.
 *
 * FILE NAME. This was `middleware.ts` until the Next.js 16 rename (the
 * `middleware` file convention is deprecated in favor of `proxy` — same
 * exported function, `config.matcher` unchanged). See
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
 */

/**
 * Pages that need an account: chat, profile/saved, and the leftover setup
 * screens. Everything else — Feed, Deals, Free, Explore, detail pages and
 * shared links — is browsable signed out (user decision 2026-09-15, re-confirmed 2026-09-26 for PMF); sign-in
 * is asked for only when Save, Notify me or Ask Fomo is tapped.
 */
const SIGNED_IN_PAGE_PREFIXES = ["/fomo", "/profile", "/saved", "/setup", "/kit"];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function needsAccount(pathname: string): boolean {
  return SIGNED_IN_PAGE_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

/**
 * Read-only catalogue APIs the public pages call. GET/HEAD only; each serves
 * data RLS already grants `read_all` to anon, and handles a missing user
 * itself. Chat, translate, saved, push, alerts, geocode and places search
 * stay behind a session — they cost money per call or write per-user rows.
 */
const PUBLIC_API_PREFIXES = [
  "/api/feed",
  "/api/happenings",
  "/api/events",
  "/api/explore",
  "/api/weather",
  "/api/now",
  "/api/media-proxy",
  // GET half of the Fomo Friday one-click unsubscribe link — the page
  // itself (app/unsubscribe/page.tsx) calls this on mount with no session.
  // The POST half (RFC 8058 one-click) is in PUBLIC_POST_PREFIXES below.
  "/api/unsubscribe",
];
const PUBLIC_PLACE_OFFERS = /^\/api\/places\/[^/]+\/offers$/;

/**
 * POST endpoints servable with no session, kept as a SEPARATE allowlist from
 * `PUBLIC_API_PREFIXES` on purpose — that list is GET/HEAD-only by design
 * (read-only catalogue reads), and widening its method check would silently
 * open every route in it to unauthenticated writes. Only /api/subscribe
 * (email capture for the "Fomo Friday" digest, app/api/subscribe/route.ts)
 * /api/tips (community-sourced deal/event tips, app/api/tips/route.ts), and
 * /api/unsubscribe (RFC 8058 one-click unsubscribe — the mail client itself
 * POSTs this, with no session and no page load; see app/api/unsubscribe/
 * route.ts) need this — none of them have a session to gate on at all.
 */
const PUBLIC_POST_PREFIXES = ["/api/subscribe", "/api/tips", "/api/unsubscribe"];

function isPublicApi(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  if (request.method === "POST") return PUBLIC_POST_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return PUBLIC_PLACE_OFFERS.test(pathname) || PUBLIC_API_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

/** Pages that are always servable regardless of auth/onboarding state. */
function isPassivePublic(pathname: string): boolean {
  return (
    pathname === "/welcome" ||
    pathname.startsWith("/welcome/") ||
    pathname === "/auth/callback" ||
    pathname.startsWith("/auth/callback/") ||
    pathname === "/offline"
  );
}

function isOnboardingPath(pathname: string): boolean {
  return pathname === "/onboarding" || pathname.startsWith("/onboarding/");
}

/** Copy every cookie `base` accumulated (from the `setAll` refresh below) onto `target`, so a redirect/401 built after the fact still carries the refreshed session. */
function withCookies(target: NextResponse, base: NextResponse): NextResponse {
  for (const cookie of base.cookies.getAll()) {
    target.cookies.set(cookie);
  }
  return target;
}

/** `<pathname>?<search>`, safe to hand to `next=` — same-origin and relative by construction (built from the request's own URL, never user input). */
function pathWithSearch(request: NextRequest): string {
  return `${request.nextUrl.pathname}${request.nextUrl.search}`;
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  if (!supabaseUrl || !supabaseAnonKey) {
    // No creds yet — nothing to refresh, and no user to gate on. Pass the
    // request through untouched rather than throwing, so the app keeps
    // working before .env.local has Supabase creds at all.
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Write onto the *request* first so any downstream code in this
        // same proxy invocation sees the refreshed cookies...
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        // ...then rebuild `response` from that updated request and copy the
        // cookies onto it too. This is the object every redirect/401 below
        // copies its cookies FROM — see footgun #1 in the file header.
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const isSignin = pathname === "/signin";

  // 1. /api/* — never a redirect. An unauthenticated call gets a 401 the
  // caller's fetch() can actually branch on; a redirect would just hand it
  // an HTML page.
  if (isApi) {
    if (!user && !isPublicApi(request)) {
      return withCookies(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        response
      );
    }
    return response;
  }

  // 2. Passive-public pages — always servable, in every auth state. Keeping
  // /welcome out of the "bounce a signed-in user away" logic below is
  // deliberate: it's harmless to view signed in, and folding it into the
  // no-user branch would need a second flag just to avoid a self-redirect.
  if (isPassivePublic(pathname)) {
    return response;
  }

  // 3. No user. Public pages are served as-is; only account pages (chat,
  // profile, saved) send the visitor through /welcome to sign in.
  if (!user) {
    // /signin is where a signed-out visitor is SUPPOSED to end up (either
    // straight from a deep link's redirect, or via /welcome's own
    // client-side skip-if-seen-intro check) — serve it directly rather than
    // bouncing back through /welcome.
    if (isSignin || !needsAccount(pathname)) return response;
    const url = new URL("/welcome", request.url);
    url.searchParams.set("next", pathWithSearch(request));
    return withCookies(NextResponse.redirect(url), response);
  }

  // From here on, `user` is non-null.

  // 4. Signed in, but sitting on /signin or under the retired /onboarding
  // paths (a stale bookmark) — bounce to ?next or Home. There is no
  // onboarding gate anymore: the trip-era onboarding flow was removed in the
  // Fomo pivot, and gating on `onboarded_at` sent every new account to a 404.
  if (isSignin || isOnboardingPath(pathname)) {
    return withCookies(
      NextResponse.redirect(new URL(safeNext(request.nextUrl.searchParams.get("next")), request.url)),
      response
    );
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Run on everything except static assets and the PWA files, which never
     * need a session refresh or a gate check:
     * - _next/static, _next/image (Next.js internals)
     * - favicon.ico, manifest.json, sw.js, icons/*
     * - common static file extensions
     */
    "/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
