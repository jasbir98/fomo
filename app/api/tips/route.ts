/**
 * Fomo — POST /api/tips
 *
 * Public, account-free tip submission for community-sourced deals and events
 * we're missing (see app/(shell)/tip/page.tsx, the form this route serves).
 * No session required: tips are allowlisted via `PUBLIC_POST_PREFIXES` in
 * proxy.ts — see that file's comment on the split.
 *
 * Body: {
 *   title: string,
 *   url?: string,
 *   details?: string,
 *   when_text?: string,
 *   price_text?: string,
 *   submitter_kind?: 'student' | 'local' | 'venue' | 'other',
 *   contact_email?: string,
 *   website?: string (honeypot)
 * }
 *
 * `website` is a honeypot — a real visitor never sees or fills this field.
 * A non-empty value means a bot filled every input it could find; respond
 * exactly as if the submission succeeded (200, `{ ok: true }`) and write
 * nothing, so a scraping bot gets no signal that it was caught.
 *
 * All tips are stored with status 'new' and go to review before publishing.
 *
 * RATE LIMITED: 10/hour/IP via `consumeAnonRateLimit` (lib/rate-limit.ts →
 * `consume_anon_rate_limit`, supabase/archive/add_anon_rate_limits.sql) — same
 * scheme as /api/subscribe, since this route also has no session to key a
 * per-user limit on. Checked after the honeypot, before field validation.
 * Fails open until that migration is applied — see lib/rate-limit.ts's file
 * header.
 */
import "server-only";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Db } from "@/lib/supabase/types";
import { consumeAnonRateLimit, anonRateLimitedResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 10, windowSeconds: 60 * 60 };

interface TipBody {
  title?: unknown;
  url?: unknown;
  details?: unknown;
  when_text?: unknown;
  price_text?: unknown;
  submitter_kind?: unknown;
  contact_email?: unknown;
  website?: unknown;
}

const MAX_TITLE_LENGTH = 200;
const MAX_URL_LENGTH = 1000;
const MAX_DETAILS_LENGTH = 2000;
const MAX_WHEN_TEXT_LENGTH = 200;
const MAX_PRICE_TEXT_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;

// Simple email validation — same as subscribe route.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Valid submitter kinds
const VALID_SUBMITTER_KINDS = ["student", "local", "venue", "other"];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * True for a PostgREST/Postgres error meaning "the `tips` table doesn't
 * exist" — same as subscribe route's isMissingTableError.
 */
function isMissingTableError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  return typeof e.message === "string" && /relation .*tips.* does not exist/i.test(e.message);
}

export async function POST(request: Request) {
  let body: TipBody;
  try {
    body = (await request.json()) as TipBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Honeypot first — a bot that filled this field gets an identical-looking
  // success with nothing written, no matter what else is wrong.
  if (isNonEmptyString(body.website)) {
    return NextResponse.json({ ok: true });
  }

  const rate = await consumeAnonRateLimit(request, "tips", RATE_LIMIT);
  if (!rate.allowed) {
    return anonRateLimitedResponse("Too many tips from this connection. Try again later.", RATE_LIMIT.windowSeconds);
  }

  // Title is required, others optional.
  if (!isNonEmptyString(body.title) || !body.title.trim() || body.title.length > MAX_TITLE_LENGTH) {
    return NextResponse.json({ error: "A title is required (up to 200 characters)" }, { status: 400 });
  }
  const title = body.title.trim();

  // URL is optional but must be valid if provided.
  let url: string | null = null;
  if (isNonEmptyString(body.url)) {
    if (body.url.length > MAX_URL_LENGTH || !isValidUrl(body.url)) {
      return NextResponse.json({ error: "Please provide a valid URL (http/https)" }, { status: 400 });
    }
    url = body.url.trim();
  }

  // Optional fields with length caps.
  const details = isNonEmptyString(body.details) ? body.details.slice(0, MAX_DETAILS_LENGTH).trim() : null;
  const when_text = isNonEmptyString(body.when_text) ? body.when_text.slice(0, MAX_WHEN_TEXT_LENGTH).trim() : null;
  const price_text = isNonEmptyString(body.price_text) ? body.price_text.slice(0, MAX_PRICE_TEXT_LENGTH).trim() : null;

  // Submitter kind validation.
  let submitter_kind: string | null = null;
  if (isNonEmptyString(body.submitter_kind)) {
    if (!VALID_SUBMITTER_KINDS.includes(body.submitter_kind)) {
      return NextResponse.json(
        { error: "Invalid submitter type" },
        { status: 400 }
      );
    }
    submitter_kind = body.submitter_kind;
  }

  // Email validation — optional but must be valid if provided.
  let contact_email: string | null = null;
  if (isNonEmptyString(body.contact_email)) {
    if (body.contact_email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(body.contact_email.trim())) {
      return NextResponse.json({ error: "Please provide a valid email" }, { status: 400 });
    }
    contact_email = body.contact_email.trim().toLowerCase();
  }

  // Get the current user if signed in (cookie session, RLS-scoped client).
  const {
    data: { user },
  } = await (await supabaseServer()).auth.getUser();
  const user_id = user?.id ?? null;

  // Insert with the service role: tips has no public insert policy
  // (supabase/tighten_public_inserts.sql), so this route — with its rate
  // limit, honeypot and validation above — is the only way in. status and
  // review_note are fixed here, and user_id only ever comes from the session.
  const db: Db = supabaseAdmin();
  const { error } = await db.from("tips").insert({
    title,
    url,
    details,
    when_text,
    price_text,
    submitter_kind,
    contact_email,
    user_id,
    status: "new",
    review_note: null,
  });

  if (error) {
    if (isMissingTableError(error)) {
      console.warn("[api/tips] tips table missing — run supabase/archive/add_tips.sql");
      return NextResponse.json(
        { error: "Tips aren't set up yet. Try again later." },
        { status: 503 }
      );
    }
    console.error("[api/tips] insert failed", error);
    return NextResponse.json({ error: "Couldn't save that. Try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
