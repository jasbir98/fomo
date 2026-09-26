/**
 * Fomo — POST /api/subscribe
 *
 * Public, account-free email capture for the weekly "Fomo Friday" digest —
 * the retention loop for the Edinburgh wedge (see SubscribeCard, the form
 * this route serves). No session required: proxy.ts's `PUBLIC_API_PREFIXES`
 * is GET/HEAD-only by design (read-only catalogue APIs), so this route is
 * allowlisted separately via `PUBLIC_POST_PREFIXES` — see that file's
 * comment on the split.
 *
 * Body: { email: string, source?: string, website?: string }
 *   `website` is a honeypot — a real visitor never sees or fills this field
 *   (SubscribeCard hides it visually and from screen readers). A non-empty
 *   value means a bot filled every input it could find; respond exactly as
 *   if the signup succeeded (200, `{ ok: true }`) and write nothing, so a
 *   scraping bot gets no signal that it was caught.
 *
 * A duplicate email (23505 on email_subscribers' normalized-email unique
 * index) is also reported as success — resubmitting the same address from a
 * second source is meant to be a no-op, and the response must never leak
 * "that address is already on the list" to a caller who doesn't already
 * know that.
 *
 * NO RATE LIMIT: lib/rate-limit.ts's `consumeRateLimit` calls
 * `consume_rate_limit` (supabase/add_rate_limits.sql), which is keyed on
 * `auth.uid()` and raises if there's no signed-in session — it can't be
 * reused for a route with no session at all. An IP-keyed limiter would need
 * a new table/function; skipped for this first pass (the honeypot plus the
 * unique-email constraint are the abuse guards for now) — worth adding if
 * this route sees real spam volume.
 */
import "server-only";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import type { Db } from "@/lib/supabase/types";

export const runtime = "nodejs";

interface SubscribeBody {
  email?: unknown;
  source?: unknown;
  website?: unknown;
}

const MAX_EMAIL_LENGTH = 254;
// Deliberately simple — "has an @ with something on each side, no
// whitespace" — this is a signup gate, not RFC 5322 validation. Real
// deliverability problems (typos, disposable domains) are the digest send
// job's problem, not this route's.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * True for a PostgREST/Postgres error meaning "the `email_subscribers`
 * table doesn't exist" — same shape as lib/db/happenings.ts's
 * isMissingTableError: `42P01` is Postgres's undefined_table code,
 * `PGRST205` is PostgREST's "not found in schema cache" equivalent. The
 * migration (supabase/add_email_subscribers.sql) has to be run by hand in
 * the Supabase SQL editor, so this route must degrade clearly rather than
 * 500 until that's done.
 */
function isMissingTableError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  return typeof e.message === "string" && /relation .*email_subscribers.* does not exist/i.test(e.message);
}

/** True for Postgres' unique_violation — the normalized-email unique index rejecting a duplicate signup. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23505";
}

export async function POST(request: Request) {
  let body: SubscribeBody;
  try {
    body = (await request.json()) as SubscribeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Honeypot first, before any validation — a bot that filled this field
  // gets an identical-looking success with nothing written, no matter what
  // else is wrong with the rest of its payload.
  if (isNonEmptyString(body.website)) {
    return NextResponse.json({ ok: true });
  }

  if (!isNonEmptyString(body.email) || body.email.length > MAX_EMAIL_LENGTH) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  const email = body.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  const source = isNonEmptyString(body.source) ? body.source.slice(0, 32) : null;

  // Typed as the permissive `Db` alias (not the raw `supabaseServer()`
  // return type) — `Database`'s `Tables: Record<string, never>` stub would
  // otherwise type this insert's row shape as `never`; see
  // lib/supabase/types.ts's doc comment and lib/supabase/admin.ts for the
  // same pattern.
  const db: Db = await supabaseServer();
  const { error } = await db.from("email_subscribers").insert({ email, source });

  if (error) {
    if (isUniqueViolation(error)) return NextResponse.json({ ok: true });
    if (isMissingTableError(error)) {
      console.warn("[api/subscribe] email_subscribers table missing — run supabase/add_email_subscribers.sql");
      return NextResponse.json(
        { error: "Signups aren't set up yet — try again later" },
        { status: 503 }
      );
    }
    console.error("[api/subscribe] insert failed", error);
    return NextResponse.json({ error: "Couldn't save that — try again" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
