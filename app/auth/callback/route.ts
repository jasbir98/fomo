import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { safeNext } from "@/lib/auth/safe-next";

/**
 * OAuth (PKCE) callback. `signInWithOAuth` in `app/signin/page.tsx` sets
 * `redirectTo` to this route with `?next=`; the provider redirects back
 * here with `?code=`, which we exchange server-side so the session lands
 * as an HttpOnly cookie (never touching client JS) — same shape Supabase's
 * docs use for App Router.
 *
 * Uses the per-request `supabaseServer()` factory from
 * `lib/supabase/server.ts`, never a module-level client — see that file's
 * doc comment for why a singleton here would leak sessions across
 * concurrent requests.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"));

  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    console.error("[auth/callback] exchangeCodeForSession failed", error.message);
  }

  return NextResponse.redirect(`${origin}/signin?error=auth_callback`);
}
