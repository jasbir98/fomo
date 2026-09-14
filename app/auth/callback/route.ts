import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { safeNext } from "@/lib/auth/safe-next";

/**
 * Auth callback for both OAuth and email links.
 *
 * - OAuth (PKCE): `signInWithOAuth` in `app/signin/page.tsx` sets `redirectTo`
 *   to this route with `?next=`; the provider redirects back with `?code=`,
 *   which we exchange server-side so the session lands as an HttpOnly cookie.
 * - Email links: an email template that links here with
 *   `?token_hash=…&type=…` (see docs/auth-email-templates.md) is verified with
 *   `verifyOtp`. Unlike a PKCE `code`, a token hash doesn't need the verifier
 *   cookie from the browser that requested it, so the link works when opened
 *   from a phone's mail app. A PKCE `code` from an email link only works in
 *   the same browser that asked for it.
 *
 * Uses the per-request `supabaseServer()` factory from
 * `lib/supabase/server.ts`, never a module-level client — see that file's
 * doc comment for why a singleton here would leak sessions across
 * concurrent requests.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(searchParams.get("next"));

  if (tokenHash && type) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    console.error("[auth/callback] verifyOtp(token_hash) failed", error.message);
  }

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
