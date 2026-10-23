/**
 * Fomo — POST/DELETE /api/push/subscribe
 *
 * POST: upsert the caller's PushSubscription (lib/push/client.ts's
 * ensurePushSubscribed calls this right after `pushManager.subscribe`).
 * DELETE: remove it (unsubscribeFromPush).
 *
 * Session gate: proxy.ts already 401s any /api/* request with no user;
 * the explicit check below is belt-and-braces, matching every other route
 * in this app (see app/api/saved/route.ts). RLS's `own_rows` policy on
 * push_subscriptions (supabase/archive/add_push_alerts.sql) is the real scoping —
 * this route can't write another user's row even if it tried.
 *
 * Endpoint allowlist: `endpoint` is only accepted when it's an `https:` URL
 * on a known push service (see lib/push/allowed-endpoint.ts) — the
 * onsale-alerts Edge Function POSTs straight to whatever endpoint is on
 * file with no further validation, so an arbitrary accepted URL would be
 * an SSRF vector.
 */
import "server-only";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { upsertPushSubscription, deletePushSubscriptionByEndpoint } from "@/lib/db/push";
import { isUnauthorizedError } from "@/lib/supabase-error";
import { isAllowedPushEndpoint } from "@/lib/push/allowed-endpoint";
import { captureServerException } from "@/lib/analytics/server-exception";

export const runtime = "nodejs";

interface SubscribeBody {
  endpoint?: unknown;
  p256dh?: unknown;
  auth?: unknown;
  userAgent?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export async function POST(request: Request) {
  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: SubscribeBody;
  try {
    body = (await request.json()) as SubscribeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isNonEmptyString(body.endpoint) || !isNonEmptyString(body.p256dh) || !isNonEmptyString(body.auth)) {
    return NextResponse.json({ error: "endpoint, p256dh and auth are required strings" }, { status: 400 });
  }
  // Endpoint is a URL a browser hands us — restricted to a known push
  // service's host, not just "any valid URL". The onsale-alerts Edge
  // Function later POSTs straight to whatever's on file with no further
  // check, so an unchecked endpoint is an SSRF vector — see
  // lib/push/allowed-endpoint.ts's doc comment.
  if (!isAllowedPushEndpoint(body.endpoint)) {
    return NextResponse.json({ error: "endpoint must be an https URL on a known push service" }, { status: 400 });
  }

  const userAgent = isNonEmptyString(body.userAgent) ? body.userAgent.slice(0, 500) : null;

  try {
    await upsertPushSubscription(db, {
      endpoint: body.endpoint,
      p256dh: body.p256dh,
      auth: body.auth,
      userAgent,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/push/subscribe] POST failed", err);
    if (isUnauthorizedError(err)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await captureServerException(err, {
      path: new URL(request.url).pathname,
      method: request.method,
      headers: request.headers,
      route: "/api/push/subscribe",
      handled: true,
    });
    return NextResponse.json({ error: "Failed to save subscription" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: SubscribeBody;
  try {
    body = (await request.json()) as SubscribeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isNonEmptyString(body.endpoint)) {
    return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
  }

  try {
    await deletePushSubscriptionByEndpoint(db, body.endpoint);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/push/subscribe] DELETE failed", err);
    if (isUnauthorizedError(err)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await captureServerException(err, {
      path: new URL(request.url).pathname,
      method: request.method,
      headers: request.headers,
      route: "/api/push/subscribe",
      handled: true,
    });
    return NextResponse.json({ error: "Failed to remove subscription" }, { status: 500 });
  }
}
