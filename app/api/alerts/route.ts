/**
 * Fomo — GET/POST/DELETE /api/alerts
 *
 * The signed-in caller's per-item "Book early" on-sale alerts (onsale_alerts,
 * supabase/add_push_alerts.sql). GET returns the raw happening-id list so
 * Home (app/(shell)/page.tsx) can mark a Book Early card's NotifyMeButton as
 * already-subscribed on load, instead of every card resetting to
 * unsubscribed on refresh. POST/DELETE toggle one happening's alert.
 *
 * Session gate: proxy.ts already 401s any /api/* request with no user;
 * explicit check kept for the same belt-and-braces reason /api/saved keeps
 * theirs. RLS's own_rows policy on onsale_alerts does the real scoping.
 */
import "server-only";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { listAlertHappeningIds, createAlert, deleteAlert } from "@/lib/db/push";
import { isUnauthorizedError } from "@/lib/supabase-error";

export const runtime = "nodejs";

interface AlertBody {
  happeningId?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// Loose UUID shape check — happening_id is a uuid column; reject anything
// that plainly isn't one before it reaches a query.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ happeningIds: [] }, { status: 401 });

  try {
    const happeningIds = await listAlertHappeningIds(db);
    return NextResponse.json({ happeningIds });
  } catch (err) {
    console.error("[api/alerts] GET failed", err);
    return NextResponse.json({ happeningIds: [] }, { status: isUnauthorizedError(err) ? 401 : 500 });
  }
}

export async function POST(request: Request) {
  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: AlertBody;
  try {
    body = (await request.json()) as AlertBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isNonEmptyString(body.happeningId) || !UUID_RE.test(body.happeningId)) {
    return NextResponse.json({ error: "happeningId must be a uuid" }, { status: 400 });
  }

  try {
    await createAlert(db, body.happeningId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/alerts] POST failed", err);
    if (isUnauthorizedError(err)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Failed to create alert" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: AlertBody;
  try {
    body = (await request.json()) as AlertBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isNonEmptyString(body.happeningId) || !UUID_RE.test(body.happeningId)) {
    return NextResponse.json({ error: "happeningId must be a uuid" }, { status: 400 });
  }

  try {
    await deleteAlert(db, body.happeningId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/alerts] DELETE failed", err);
    if (isUnauthorizedError(err)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Failed to remove alert" }, { status: 500 });
  }
}
