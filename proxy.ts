import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/auth/safe-next";

/**
 * Phase 4 (Onboarding + the real gate) of plan-v1.2-accounts.md — the wall
 * is now on. This proxy both refreshes the Supabase session cookie AND
 * gates every request per §A.2:
 *
 *   1. refresh session cookies (Phase 1 code — unchanged, see footgun #1)
 *   2. read the user (Phase 1's getUser() call — unchanged, see footgun #2)
 *   3. /api/*        → no user? 401 JSON, never a redirect
 *      passive-public (/welcome, /auth/callback, /offline) → always pass
 *      no user        → 302 /welcome?next=... (unless already on /signin)
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
    if (!user) {
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

  // 3. No user.
  if (!user) {
    // /signin is where a signed-out visitor is SUPPOSED to end up (either
    // straight from a deep link's redirect, or via /welcome's own
    // client-side skip-if-seen-intro check) — serve it directly rather than
    // bouncing back through /welcome.
    if (isSignin) return response;
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
