/**
 * How many Ask Fomo questions the visitor has left today, so the chat screen
 * can say so before they run out: per IP when signed out, per user when
 * signed in (lib/chat/limits.ts has both allowances).
 */
import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { peekAnonRateLimit, peekRateLimit } from "@/lib/rate-limit";
import {
  CHAT_ANON_DAILY_LIMIT,
  CHAT_ANON_ROUTE,
  CHAT_USER_DAILY_LIMIT,
  CHAT_USER_ROUTE,
  anonWindowResetsAt,
} from "@/lib/chat/limits";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();

  let body: Record<string, unknown>;
  if (user) {
    const { limit, windowSeconds } = CHAT_USER_DAILY_LIMIT;
    const used = await peekRateLimit(user.id, CHAT_USER_ROUTE, windowSeconds);
    body = { signedIn: true, limit, used, remaining: Math.max(0, limit - used), resetsAt: anonWindowResetsAt(windowSeconds) };
  } else {
    const { limit, windowSeconds } = CHAT_ANON_DAILY_LIMIT;
    const used = await peekAnonRateLimit(req, CHAT_ANON_ROUTE, windowSeconds);
    body = { signedIn: false, limit, used, remaining: Math.max(0, limit - used), resetsAt: anonWindowResetsAt(windowSeconds) };
  }
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
