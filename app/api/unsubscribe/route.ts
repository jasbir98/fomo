/**
 * Fomo — GET/POST /api/unsubscribe
 *
 * The write side of the Fomo Friday one-click unsubscribe link
 * (scripts/fomo-friday.mjs embeds `https://askfomo.com/unsubscribe?token=…`
 * in every digest's footer, plus `List-Unsubscribe`/`List-Unsubscribe-Post`
 * headers per RFC 8058).
 *
 * GET  — the link a person clicks from the email footer. app/unsubscribe/
 *        page.tsx calls this itself (client-side, on mount) rather than
 *        this route redirecting or rendering HTML directly, so the page can
 *        control its own loading/success UI.
 * POST — the "one-click" mechanism RFC 8058 / Gmail & Yahoo's 2024 bulk-
 *        sender rules require: the mail client itself POSTs
 *        `List-Unsubscribe=One-Click` with no page load and no user
 *        keystroke beyond clicking "Unsubscribe" in their own mail UI.
 *
 * Both accept the same `token` (query string for GET, `List-Unsubscribe`
 * one-click POST has no body per RFC 8058 — token comes from the query
 * string there too, since the mail client only ever POSTs the URL from the
 * header verbatim).
 *
 * NO ENUMERATION: every response is the same neutral shape whether the
 * token matched a row, matched an already-unsubscribed row, or matched
 * nothing at all — never "no such subscriber" vs "already unsubscribed",
 * which would let a caller fish for whether a given token (and thus,
 * indirectly, an email address someone else received the digest at) is
 * live.
 *
 * Public: proxy.ts's PUBLIC_API_PREFIXES is GET/HEAD-only by design (see
 * that file's comment on the POST/GET split), so this route's POST needs
 * its own entry in PUBLIC_POST_PREFIXES — added there. The GET half is
 * already covered by PUBLIC_API_PREFIXES.
 *
 * Uses the service-role admin client (lib/supabase/admin.ts) — the same
 * "write-only mailbox" table `email_subscribers` has no anon UPDATE policy
 * (see supabase/archive/add_email_subscribers.sql), by design: nobody signed out
 * should be able to flip unsubscribed_at on an arbitrary row via a guessed
 * id, only via a real 122-bit token match.
 */
import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const NEUTRAL_MESSAGE = "You're unsubscribed. You won't get any more Fomo Friday emails.";

// Matches any RFC 4122 UUID (all versions/variants) — the exact shape
// `unsubscribe_token` is generated as (`gen_random_uuid()`,
// supabase/archive/add_email_subscribers.sql).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidToken(token: string | null): token is string {
  return typeof token === "string" && UUID_RE.test(token);
}

/**
 * Sets `unsubscribed_at = now()` for the row matching `token`, if any.
 * Deliberately swallows "no matching row" (PostgREST returns an empty
 * array, not an error, for an UPDATE that matches nothing) — same neutral
 * outcome as a genuine match, by design (see the no-enumeration note
 * above). Only a real DB/network error is surfaced to the caller as a
 * failure; even then the route still answers with the neutral message
 * (logged server-side, never exposed) since a transient DB hiccup on an
 * unsubscribe request must never block someone's ability to opt out, and a
 * try-again message would itself be a signal.
 */
async function applyUnsubscribe(token: string): Promise<void> {
  try {
    const db = supabaseAdmin();
    // supabase-js returns errors rather than throwing -- log them, or a
    // broken unsubscribe would fail silently behind the neutral message.
    const { error } = await db
      .from("email_subscribers")
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq("unsubscribe_token", token)
      .is("unsubscribed_at", null);
    if (error) console.error("[api/unsubscribe] update failed", error);
  } catch (err) {
    console.error("[api/unsubscribe] update failed", err);
  }
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  if (isValidToken(token)) await applyUnsubscribe(token);
  // Neutral 200 regardless of whether `token` was valid/matched — see the
  // no-enumeration note above. An invalid/missing token just never touches
  // the DB; the response is identical either way.
  return NextResponse.json({ ok: true, message: NEUTRAL_MESSAGE });
}

/**
 * RFC 8058 one-click POST. Mail clients send this with
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` and no body — the
 * token travels in the URL's query string (the exact `List-Unsubscribe`
 * header value the digest set), same as the GET path above.
 */
export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  if (isValidToken(token)) await applyUnsubscribe(token);
  return NextResponse.json({ ok: true, message: NEUTRAL_MESSAGE });
}
