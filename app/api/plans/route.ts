/**
 * Fomo — POST /api/plans
 *
 * Makes a shareable weekend plan (askfomo.com/plan/<id>) from 2–4 picks.
 * Public and account-free (allowlisted in proxy.ts's PUBLIC_POST_PREFIXES).
 *
 * Body: { items: { kind: "happening" | "event", id: uuid, day?: "YYYY-MM-DD" }[] }
 * Returns { id } — the same id for the same picks (lib/plans/snapshot.ts's
 * `planItemsHash`), so re-sharing never piles up duplicate rows.
 *
 * Only refs are accepted; lib/plans/snapshot.ts reads every title, price and
 * image from the live rows. RATE LIMITED: 20/hour per IP plus 3,000/day
 * site-wide (lib/rate-limit.ts, fail-open until the anon limiter migration
 * exists, like /api/subscribe). 503 until supabase/add_plans.sql has run.
 */
import "server-only";
import { after, NextResponse } from "next/server";
import { anonRateLimitedResponse, consumeAnonRateLimit, consumeGlobalRateLimit } from "@/lib/rate-limit";
import { captureServerException } from "@/lib/analytics/server-exception";
import { PlansUnavailableError, savePlan } from "@/lib/plans/db";
import { buildPlanItems, planItemsHash } from "@/lib/plans/snapshot";
import { PLAN_MAX_ITEMS, PLAN_MIN_ITEMS, type PlanRef } from "@/lib/plans/types";

export const runtime = "nodejs";

const IP_LIMIT = { limit: 20, windowSeconds: 60 * 60 };
const GLOBAL_LIMIT = { limit: 3000, windowSeconds: 24 * 60 * 60 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Requests the plan page and its share image once, right after the plan is
 * made, so both are rendered and cached (ISR) before anyone pastes the link.
 * WhatsApp only waits a few seconds for a preview, and a cold render of the
 * image fetches up to four photos. Best effort: failures are only logged.
 */
async function warmPlan(origin: string, id: string) {
  try {
    const res = await fetch(`${origin}/plan/${id}`, { signal: AbortSignal.timeout(20_000) });
    const html = await res.text();
    const images = [...html.matchAll(/<meta (?:property="og:image"|name="twitter:image") content="([^"]+)"/g)].map((m) =>
      m[1].replace(/&amp;/g, "&").replace(/^https?:\/\/[^/]+/, origin)
    );
    await Promise.all(images.map((url) => fetch(url, { signal: AbortSignal.timeout(20_000) }).then((r) => r.arrayBuffer())));
  } catch (err) {
    console.warn(`[api/plans] warming /plan/${id} failed`, err instanceof Error ? err.message : err);
  }
}

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function parseRefs(body: unknown): PlanRef[] | null {
  const raw = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw) || raw.length < PLAN_MIN_ITEMS || raw.length > PLAN_MAX_ITEMS) return null;
  const refs: PlanRef[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const { kind, id, day } = (r ?? {}) as Record<string, unknown>;
    if ((kind !== "happening" && kind !== "event") || typeof id !== "string" || !UUID_RE.test(id)) return null;
    if (day != null && (typeof day !== "string" || !DAY_RE.test(day))) return null;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind, id: id.toLowerCase(), day: (day as string | undefined) ?? null });
  }
  return refs.length >= PLAN_MIN_ITEMS ? refs : null;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("invalid_json");
  }
  const refs = parseRefs(body);
  if (!refs) return bad(`Pick ${PLAN_MIN_ITEMS} to ${PLAN_MAX_ITEMS} things.`);

  const [ip, global] = await Promise.all([
    consumeAnonRateLimit(request, "plans", IP_LIMIT),
    consumeGlobalRateLimit("plans_global", GLOBAL_LIMIT),
  ]);
  if (!ip.allowed || !global.allowed) {
    return anonRateLimitedResponse("You've made a lot of plans. Try again in a bit.", IP_LIMIT.windowSeconds);
  }

  try {
    const items = await buildPlanItems(refs);
    if (items.length < PLAN_MIN_ITEMS) {
      return bad("Some of those have ended. Pick another and try again.", 422);
    }
    const { id, created } = await savePlan(items, planItemsHash(items));
    after(() => warmPlan(new URL(request.url).origin, id));
    return NextResponse.json({ id, created }, { status: created ? 201 : 200 });
  } catch (err) {
    if (err instanceof PlansUnavailableError) {
      console.warn(`[api/plans] ${err.message}`);
      return bad("unavailable", 503);
    }
    console.error("[api/plans] failed", err);
    await captureServerException(err, {
      path: new URL(request.url).pathname,
      method: request.method,
      headers: request.headers,
      route: "/api/plans",
      handled: true,
    });
    return bad("server_error", 500);
  }
}
