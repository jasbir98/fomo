/**
 * Fomo — POST /api/resend/webhook
 *
 * Resend's webhook endpoint (configured in the Resend dashboard against
 * this URL). Public — proxy.ts's `PUBLIC_POST_PREFIXES` allowlists it — no
 * session exists for Resend's own server to carry; the Svix signature
 * (verified below via lib/resend/verify-webhook.ts) is what stands in for
 * auth. Runs on every send/delivery/open/click/bounce/complaint event for
 * this account, not just Fomo Friday.
 *
 * Storage: every verified event is written to `email_events`
 * (supabase/add_email_events.sql) — a plain append-only log for later
 * debugging/analytics, never read by any other route today.
 *
 * Suppression: on `email.bounced` (hard/permanent only — a soft/transient
 * bounce is often just "mailbox full this once" and shouldn't cost someone
 * their subscription) or `email.complained` (spam complaint — always
 * unsubscribe, no soft/hard distinction exists for a complaint), the
 * matching `email_subscribers` row is marked unsubscribed via the same
 * `unsubscribed_at` column app/api/unsubscribe/route.ts sets. Matched by
 * `email_normalized` (the generated lower/trim column), never a bare
 * string-equality on `email`, for the same reason the unsubscribe route
 * doesn't: user-entered casing/whitespace shouldn't matter.
 *
 * Responses: 200 quickly on success (Resend's own delivery guarantee
 * retries on anything else, so don't make it wait); 401 on a bad/missing
 * signature; 503 if RESEND_WEBHOOK_SECRET isn't set yet (same "not
 * configured yet" shape as the missing-table branches elsewhere in this
 * app) — 503 rather than 200 so Resend's dashboard actually shows this
 * failing until the secret is added, instead of silently succeeding.
 */
import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { verifyResendWebhookSignature } from "@/lib/resend/verify-webhook";
import type { Db } from "@/lib/supabase/types";

export const runtime = "nodejs";

interface ResendWebhookEvent {
  type?: unknown;
  data?: Record<string, unknown>;
}

/** First recipient address — Resend's `data.to` is normally a one-element array, but a bare string is accepted defensively. */
function firstRecipient(to: unknown): string | null {
  if (typeof to === "string" && to.trim()) return to.trim();
  if (Array.isArray(to) && typeof to[0] === "string" && to[0].trim()) return to[0].trim();
  return null;
}

function clickedLinkFrom(data: Record<string, unknown>): string | null {
  const click = data.click;
  if (click && typeof click === "object" && typeof (click as { link?: unknown }).link === "string") {
    return (click as { link: string }).link;
  }
  return null;
}

/**
 * True for a hard/permanent bounce only. Resend's `email.bounced` payload
 * carries `data.bounce.type` as "Permanent" | "Transient" | "Undetermined"
 * (mirroring the underlying SES/Postfix classification) when it's present.
 * A payload with no `bounce.type` at all is treated as permanent — a
 * webhook event with no soft/hard signal is safer to treat as "stop
 * sending" than to silently keep mailing an address that already bounced
 * once with unknown severity.
 */
function isHardBounce(data: Record<string, unknown>): boolean {
  const bounce = data.bounce;
  if (bounce && typeof bounce === "object" && typeof (bounce as { type?: unknown }).type === "string") {
    const t = (bounce as { type: string }).type.toLowerCase();
    return t === "permanent" || t === "hardbounce" || t === "hard_bounce";
  }
  return true;
}

/** True for a PostgREST/Postgres "table doesn't exist" error — supabase/add_email_events.sql hasn't been run yet. Same shape as every other route's isMissingTableError. */
function isMissingTableError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  return typeof e.message === "string" && /relation .*email_events.* does not exist/i.test(e.message);
}

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[api/resend/webhook] RESEND_WEBHOOK_SECRET not set — refusing webhook delivery.");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  // Signing covers the exact raw bytes — read as text once, never
  // JSON.parse-then-stringify before verifying (that could reformat the
  // body and break the signature even for a genuine request).
  const rawBody = await request.text();

  const verification = verifyResendWebhookSignature({
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
    rawBody,
    secret,
  });

  if (!verification.ok) {
    console.warn(`[api/resend/webhook] signature verification failed: ${verification.reason}`);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: ResendWebhookEvent;
  try {
    event = JSON.parse(rawBody) as ResendWebhookEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const type = typeof event.type === "string" ? event.type : "unknown";
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const resendEmailId = typeof data.email_id === "string" ? data.email_id : null;
  const recipient = firstRecipient(data.to);
  const clickedLink = type === "email.clicked" ? clickedLinkFrom(data) : null;

  const db: Db = supabaseAdmin();

  const { error: insertError } = await db.from("email_events").insert({
    resend_email_id: resendEmailId,
    type,
    recipient,
    clicked_link: clickedLink,
    raw: event,
  });
  if (insertError) {
    if (isMissingTableError(insertError)) {
      console.warn("[api/resend/webhook] email_events table missing — run supabase/add_email_events.sql");
    } else {
      console.error("[api/resend/webhook] failed to store event", insertError);
    }
    // Not returned early / not a 5xx — a valid, correctly-signed webhook
    // whose only problem is "the log table isn't there yet" shouldn't
    // trigger Resend's retry loop; the suppression logic below still
    // matters and doesn't depend on this insert having succeeded.
  }

  const shouldUnsubscribe = (type === "email.bounced" && isHardBounce(data)) || type === "email.complained";
  if (shouldUnsubscribe && recipient) {
    const { error: updateError } = await db
      .from("email_subscribers")
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq("email_normalized", recipient.toLowerCase())
      .is("unsubscribed_at", null);
    if (updateError) {
      console.error("[api/resend/webhook] failed to unsubscribe after bounce/complaint", updateError);
    }
  }

  return NextResponse.json({ ok: true });
}
