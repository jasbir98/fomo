import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/auth/safe-next";
import type { SigninReason } from "@/lib/auth/signin-reason";

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
 *                      302 /signin?next=...&reason=... (unless already on /signin)
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
 * WELCOME VS SIGNIN. The 3-slide intro (app/welcome/page.tsx) isn't on the
 * account-gate path any more (pre-launch fix, 2026-09) — hitting a
 * gated page signed out goes straight to /signin?next=...&reason=...
 * (lib/auth/signin-reason.ts), which reads faster for a returning visitor
 * and gives Ask Fomo/Profile a one-line reason instead of an unrelated
 * intro. /welcome itself is untouched and still reachable by direct link;
 * it remains a passive-public page (fine to view in any auth state) and
 * still self-redirects to /signin (localStorage `fomo_seen_intro`) once
 * its own "Skip"/finish flow has been seen.
 *
 * FILE NAME. This was `middleware.ts` until the Next.js 16 rename (the
 * `middleware` file convention is deprecated in favor of `proxy` — same
 * exported function, `config.matcher` unchanged). See
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
 */

/**
 * Pages that need an account: profile only. Everything else — Feed, Deals,
 * Free, Explore, Saved, detail pages, shared links and Ask Fomo (/fomo) — is
 * browsable signed out (user decision 2026-09-15, re-confirmed 2026-09-26
 * for PMF). Signed-out Ask Fomo gets 3 questions a day per IP with no stored
 * history (app/api/chat/route.ts); sign-in is asked for when Save or Notify
 * me is tapped, or the free questions run out.
 */
const SIGNED_IN_PAGE_PREFIXES = ["/profile"];

/**
 * Which `reason` (lib/auth/signin-reason.ts) explains why a signed-out
 * visitor landed on /signin, keyed by the account-gated prefix above. A
 * prefix with no entry here just redirects with no `reason` — /signin
 * shows its plain form.
 */
const SIGNIN_REASON_BY_PREFIX: Partial<Record<string, SigninReason>> = {
  "/profile": "profile",
};

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function needsAccount(pathname: string): boolean {
  return SIGNED_IN_PAGE_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

function signinReasonForPath(pathname: string): SigninReason | null {
  for (const prefix of SIGNED_IN_PAGE_PREFIXES) {
    if (matchesPrefix(pathname, prefix)) return SIGNIN_REASON_BY_PREFIX[prefix] ?? null;
  }
  return null;
}

/**
 * Read-only catalogue APIs the public pages call. GET/HEAD only; each serves
 * data RLS already grants `read_all` to anon, and handles a missing user
 * itself. Saved, push and alerts stay behind a session — they write per-user
 * rows. (Chat is public too, but POST-only; see PUBLIC_POST_PREFIXES.)
 */
const PUBLIC_API_PREFIXES = [
  "/api/feed",
  "/api/happenings",
  "/api/explore",
  // Live Finds (GET only): the For you page (/for-you) and the "Picked for you" badge store.
  "/api/finds",
  "/api/weather",
  // GET half of the Fomo Friday one-click unsubscribe link — the page
  // itself (app/unsubscribe/page.tsx) calls this on mount with no session.
  // The POST half (RFC 8058 one-click) is in PUBLIC_POST_PREFIXES below.
  "/api/unsubscribe",
  // Signed-out visitors' remaining free Ask Fomo questions (GET only; the chat POST itself is in PUBLIC_POST_PREFIXES).
  "/api/chat/quota",
  // The tip form's "Where?" suggestions (Google, GET only, capped per IP and site-wide in the route).
  "/api/tips/places",
];
const PUBLIC_PLACE_OFFERS = /^\/api\/places\/[^/]+\/offers$/;
// Only the .ics download off a single event is public — the bare
// /api/events?destination=… route (which would otherwise let anyone trigger
// paid Mapbox geocoding + Ticketmaster/Skiddle calls + service-role cache
// writes with an arbitrary destination string) is gone entirely (2026-09
// cleanup), not merely excluded here. See app/api/events/[id]/ics/route.ts's
// doc comment.
const PUBLIC_EVENT_ICS = /^\/api\/events\/[^/]+\/ics$/;

/**
 * POST endpoints servable with no session, kept as a SEPARATE allowlist from
 * `PUBLIC_API_PREFIXES` on purpose — that list is GET/HEAD-only by design
 * (read-only catalogue reads), and widening its method check would silently
 * open every route in it to unauthenticated writes. /api/subscribe (email
 * capture for the "Fomo Friday" digest, app/api/subscribe/route.ts),
 * /api/tips (community-sourced deal/event tips, app/api/tips/route.ts),
 * /api/unsubscribe (RFC 8058 one-click unsubscribe — the mail client itself
 * POSTs this, with no session and no page load; see app/api/unsubscribe/
 * route.ts), and /api/resend/webhook (Resend's own server delivers
 * send/bounce/complaint events here — see app/api/resend/webhook/route.ts,
 * which verifies the Svix signature itself since there's no session to
 * gate on) need this — none of them have a session to gate on at all.
 * /api/chat (Ask Fomo) is here so signed-out visitors can ask: the route
 * checks the session itself and applies strict per-IP limits when there
 * isn't one (3 questions and 1 Google lookup a day, plus site-wide caps).
 */
// /api/plans: the shareable weekend plan link (account-free; rate limited per IP in the route).
const PUBLIC_POST_PREFIXES = ["/api/subscribe", "/api/tips", "/api/unsubscribe", "/api/resend/webhook", "/api/chat", "/api/plans"];

function isPublicApi(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  if (request.method === "POST") return PUBLIC_POST_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return (
    PUBLIC_PLACE_OFFERS.test(pathname) ||
    PUBLIC_EVENT_ICS.test(pathname) ||
    PUBLIC_API_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))
  );
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

/**
 * PostHog reverse proxy (instrumentation-client.ts's `api_host: "/ingest"`).
 * Done here rather than as next.config rewrites so the browser's cookies —
 * including the Supabase session tokens — are stripped before the request
 * leaves for posthog.com; a config rewrite forwards every request header
 * upstream. Returns before any Supabase work, so analytics calls never cost
 * an auth round trip. EU cloud only (the account's data residency).
 */
const POSTHOG_UPSTREAMS: ReadonlyArray<readonly [prefix: string, upstream: string]> = [
  ["/ingest/static/", "https://eu-assets.i.posthog.com/static/"],
  ["/ingest/", "https://eu.i.posthog.com/"],
];

function posthogRewrite(request: NextRequest): NextResponse | null {
  const { pathname, search } = request.nextUrl;
  for (const [prefix, upstream] of POSTHOG_UPSTREAMS) {
    if (!pathname.startsWith(prefix)) continue;
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    return NextResponse.rewrite(new URL(`${pathname.slice(prefix.length)}${search}`, upstream), {
      request: { headers },
    });
  }
  return null;
}

/**
 * Next's own trailing-slash redirect, scoped. next.config.ts turns it off
 * site-wide (`skipTrailingSlashRedirect`, the only switch Next has) so the
 * /ingest/* paths above reach PostHog exactly as sent; every other path gets
 * the same permanent redirect Next would have issued ("/weekend/" ->
 * "/weekend"), so a page never answers on two URLs.
 */
function trailingSlashRedirect(request: NextRequest): NextResponse | null {
  const { pathname } = request.nextUrl;
  if (pathname === "/" || !pathname.endsWith("/")) return null;
  const url = request.nextUrl.clone();
  url.pathname = pathname.replace(/\/+$/, "") || "/";
  return NextResponse.redirect(url, 308);
}

export async function proxy(request: NextRequest) {
  const ingest = posthogRewrite(request);
  if (ingest) return ingest;

  const slashed = trailingSlashRedirect(request);
  if (slashed) return slashed;

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
  // profile) send the visitor to /signin.
  if (!user) {
    // /signin is where a signed-out visitor is SUPPOSED to end up — serve it
    // directly rather than bouncing back through /welcome. Account-gated
    // pages (Ask Fomo, Profile, ...) go straight to /signin too, each with a
    // `reason` (lib/auth/signin-reason.ts) explaining why, instead of the
    // 3-slide intro — /welcome is no longer on this path (see its own file
    // header) but stays reachable directly for anyone who lands on it.
    if (isSignin || !needsAccount(pathname)) return response;
    const url = new URL("/signin", request.url);
    url.searchParams.set("next", pathWithSearch(request));
    const reason = signinReasonForPath(pathname);
    if (reason) url.searchParams.set("reason", reason);
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
