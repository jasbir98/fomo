/**
 * Fomo — POST /api/subscribe
 *
 * Public, account-free email capture for the weekly weekend email —
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
 * RATE LIMITED: 5/hour/IP via `consumeAnonRateLimit` (lib/rate-limit.ts →
 * `consume_anon_rate_limit`, supabase/archive/add_anon_rate_limits.sql) — the
 * per-user `consumeRateLimit`/`consume_rate_limit` pair can't be reused
 * here since it's keyed on `auth.uid()` and this route has no session at
 * all. Checked after the honeypot (a caught bot never touches the limiter)
 * but before the email is validated, so a flood of malformed bodies still
 * counts against the sender's bucket. Fails open until that migration is
 * applied — see lib/rate-limit.ts's file header.
 *
 * WELCOME EMAIL: fired (via `after()`, so it never delays the response)
 * for a genuinely NEW row only — never on the 23505 duplicate-email path.
 * Uses the service-role admin client for the insert (not `supabaseServer()`)
 * so the `.select("unsubscribe_token")` after the insert actually returns a
 * row: `email_subscribers` has an INSERT policy but no SELECT policy (see
 * supabase/archive/add_email_subscribers.sql — write-only mailbox by design), so an
 * anon/authenticated-scoped insert+select would have the RETURNING clause
 * silently filtered to nothing by RLS. Sent via Resend's REST API directly
 * (RESEND_API_KEY, FOMO_FROM_EMAIL) — both read from `process.env` at call
 * time and skipped silently (logged once) if either is unset, so signups
 * work before those env vars exist.
 */
import "server-only";
import { after, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Db } from "@/lib/supabase/types";
import { consumeAnonRateLimit, anonRateLimitedResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 5, windowSeconds: 60 * 60 };

// --- Welcome email (Resend REST — no SDK dependency, same pattern as
// scripts/fomo-friday.mjs) --------------------------------------------------

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
// A bare address shows its local part as the sender name in inboxes — same
// normalization as scripts/fomo-friday.mjs's FOMO_FROM_EMAIL.
const RAW_FROM = (process.env.FOMO_FROM_EMAIL ?? "").trim();
const FOMO_FROM_EMAIL = RAW_FROM && !RAW_FROM.includes("<") ? `Fomo <${RAW_FROM}>` : RAW_FROM;
const SENDER_ADDRESS = process.env.SENDER_ADDRESS ?? "";
const NAVY = "#1b365d";

let warnedMissingResendEnv = false;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function welcomeHtml(email: string, weekendUrl: string, unsubscribeUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Welcome to Fomo</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f8;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;">
  <tr>
    <td style="background:${NAVY};padding:24px;text-align:center;">
      <div style="color:#ffffff;font-size:26px;font-weight:800;letter-spacing:-0.03em;">fom<span style="color:#fc8a40;">o</span></div>
      <div style="color:#c7d2e3;font-size:13px;margin-top:4px;">Edinburgh, free &amp; cheap</div>
    </td>
  </tr>
  <tr>
    <td style="padding:28px 24px 8px;">
      <div style="font-size:18px;font-weight:800;color:${NAVY};">You're on the list</div>
      <p style="color:#3d4552;font-size:14px;line-height:1.6;margin:8px 0 0;">Every Thursday by 6pm, one email: the free and under-£10 things worth doing in Edinburgh that weekend.</p>
    </td>
  </tr>
  <tr>
    <td style="padding:4px 24px 28px;text-align:center;">
      <a href="${escapeHtml(weekendUrl)}" style="display:inline-block;background:${NAVY};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:999px;">See this weekend</a>
    </td>
  </tr>
  <tr>
    <td style="padding:16px 24px 28px;text-align:center;color:#8b93a3;font-size:11px;line-height:1.6;">
      You're getting this because ${escapeHtml(email)} signed up for Fomo's weekend email at askfomo.com.<br />
      ${SENDER_ADDRESS ? `${escapeHtml(SENDER_ADDRESS)}<br />` : ""}
      Not you? <a href="${escapeHtml(unsubscribeUrl)}" style="color:#8b93a3;text-decoration:underline;">Unsubscribe</a>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function welcomeText(email: string, weekendUrl: string, unsubscribeUrl: string): string {
  return [
    "Fomo · Edinburgh, free & cheap",
    "",
    "You're on the list.",
    "",
    "Every Thursday by 6pm, one email: the free and under-£10 things worth doing in Edinburgh that weekend.",
    "",
    `See this weekend: ${weekendUrl}`,
    "",
    `You're getting this because ${email} signed up for Fomo's weekend email at askfomo.com.`,
    ...(SENDER_ADDRESS ? [SENDER_ADDRESS] : []),
    `Not you? Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");
}

/**
 * Fires the welcome email for a brand-new subscriber. Best-effort only:
 * every failure path here (missing env, Resend HTTP error, thrown
 * exception) is logged and swallowed, never re-thrown — this runs inside
 * `after()`, after the `{ ok: true }` response has already gone out, so
 * there is no request left to fail even if this does.
 */
async function sendWelcomeEmail(email: string, unsubscribeToken: string): Promise<void> {
  if (!RESEND_API_KEY || !FOMO_FROM_EMAIL) {
    if (!warnedMissingResendEnv) {
      warnedMissingResendEnv = true;
      console.warn("[api/subscribe] RESEND_API_KEY/FOMO_FROM_EMAIL not set — skipping welcome email.");
    }
    return;
  }

  const weekendUrl = "https://askfomo.com/weekend?utm_source=email&utm_medium=newsletter&utm_campaign=welcome";
  const unsubscribeUrl = `https://askfomo.com/unsubscribe?token=${unsubscribeToken}`;
  const apiUnsubscribeUrl = `https://askfomo.com/api/unsubscribe?token=${unsubscribeToken}`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FOMO_FROM_EMAIL,
        reply_to: "support@askfomo.com",
        to: [email],
        subject: "Welcome to Fomo: free & cheap things in Edinburgh",
        html: welcomeHtml(email, weekendUrl, unsubscribeUrl),
        text: welcomeText(email, weekendUrl, unsubscribeUrl),
        headers: {
          // RFC 8058 one-click — same "page for humans, API route for the
          // mail client's automated POST" split as scripts/fomo-friday.mjs.
          "List-Unsubscribe": `<${apiUnsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    });
    if (!res.ok) {
      const responseBody = await res.text();
      console.error(`[api/subscribe] welcome email send failed: ${res.status} ${responseBody}`);
    }
  } catch (err) {
    console.error("[api/subscribe] welcome email send threw", err);
  }
}

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
 * migration (supabase/archive/add_email_subscribers.sql) has to be run by hand in
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

  const rate = await consumeAnonRateLimit(request, "subscribe", RATE_LIMIT);
  if (!rate.allowed) {
    return anonRateLimitedResponse("Too many signups from this connection. Try again later.", RATE_LIMIT.windowSeconds);
  }

  if (!isNonEmptyString(body.email) || body.email.length > MAX_EMAIL_LENGTH) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  const email = body.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  const source = isNonEmptyString(body.source) ? body.source.slice(0, 32) : null;

  // Admin (service-role) client, not `supabaseServer()` — needed so the
  // `.select()` below actually returns the inserted row's unsubscribe_token
  // (see the file header: email_subscribers has no SELECT RLS policy, so a
  // session-scoped insert+select would come back empty). Typed as the
  // permissive `Db` alias for the same reason as lib/supabase/admin.ts's
  // doc comment (`Database`'s `Tables: Record<string, never>` stub).
  const db: Db = supabaseAdmin();
  const { data: inserted, error } = await db
    .from("email_subscribers")
    .insert({ email, source })
    .select("unsubscribe_token")
    .single();

  if (error) {
    if (isUniqueViolation(error)) return NextResponse.json({ ok: true });
    if (isMissingTableError(error)) {
      console.warn("[api/subscribe] email_subscribers table missing — run supabase/archive/add_email_subscribers.sql");
      return NextResponse.json(
        { error: "Signups aren't set up yet. Try again later." },
        { status: 503 }
      );
    }
    console.error("[api/subscribe] insert failed", error);
    return NextResponse.json({ error: "Couldn't save that. Try again." }, { status: 500 });
  }

  // New subscriber (not a duplicate — that path already returned above) —
  // send the welcome email without delaying this response.
  const unsubscribeToken = (inserted as { unsubscribe_token?: string } | null)?.unsubscribe_token;
  if (unsubscribeToken) {
    after(() => sendWelcomeEmail(email, unsubscribeToken));
  }

  return NextResponse.json({ ok: true });
}
