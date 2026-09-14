/**
 * Fomo Practicalities Dismiss — POST /api/practicalities/dismiss
 *   Identity comes from the session cookie (lib/supabase/server.ts), not a
 *   query param — see plan-v1.2-accounts.md §A.5. No session -> 401.
 *
 *   body: { countryCode: string; topic: PracticalityTopic }
 *   → { ok: true }
 *
 * "Already sorted" (plan-v1.2-accounts.md §E.2): the client (components/
 * fomo/Card.tsx) optimistically hides the card, POSTs here, then refetches
 * GET /api/now — this route's only job is the write. Runs through
 * lib/db/practicalities.ts's dismissTopic, which upserts on
 * (user_id, country_code, topic), so a duplicate dismiss is a no-op, not an
 * error.
 *
 * `topic` is validated against the fixed PracticalityTopic literal set
 * before it ever reaches the DB — it's the dismissal key
 * (practicality_dismissals' primary key), so it must never drift into free
 * text (plan §E.1's own instruction, mirrored here as the one place
 * user-supplied JSON could otherwise inject an arbitrary string into it).
 */
import "server-only";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { dismissTopic } from "@/lib/db/practicalities";
import type { PracticalityTopic } from "@/lib/types";
import { isUnauthorizedError } from "@/lib/supabase-error";

export const runtime = "nodejs";

const VALID_TOPICS: readonly PracticalityTopic[] = [
  "connectivity",
  "money",
  "transit",
  "power",
  "water",
  "tipping",
  "safety",
];

interface DismissBody {
  countryCode?: string;
  topic?: string;
}

export async function POST(request: Request) {
  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: DismissBody;
  try {
    body = (await request.json()) as DismissBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }

  const countryCode = body.countryCode?.trim();
  const topic = body.topic;
  if (!countryCode || !topic || !VALID_TOPICS.includes(topic as PracticalityTopic)) {
    return NextResponse.json({ ok: false, error: "invalid countryCode/topic" }, { status: 400 });
  }

  try {
    await dismissTopic(db, countryCode, topic as PracticalityTopic);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/practicalities/dismiss] failed", err);
    return NextResponse.json(
      { ok: false, error: isUnauthorizedError(err) ? "unauthorized" : "failed" },
      { status: isUnauthorizedError(err) ? 401 : 500 }
    );
  }
}
