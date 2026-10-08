/**
 * Ask Fomo allowances, shared by app/api/chat (enforces them) and
 * app/api/chat/quota (reports them) so the two can't drift apart.
 *
 * Questions themselves are cheap (about $0.0007 each on DeepSeek, mostly
 * cached catalogue), so the signed-in allowance is generous; Google Maps
 * lookups are about 50x that, so they're capped tightly in app/api/chat.
 */

/** Signed-out visitors: 3 questions a day per IP, and no history is stored server-side. */
export const CHAT_ANON_DAILY_LIMIT = { limit: 3, windowSeconds: 24 * 60 * 60 };

/** `anon_rate_limits.route` for that allowance. */
export const CHAT_ANON_ROUTE = "chat:anon-day";

/** Signed-in users on the free plan: 30 questions a day. */
export const CHAT_USER_DAILY_LIMIT = { limit: 30, windowSeconds: 24 * 60 * 60 };

/** `api_rate_limits.route` for that allowance. */
export const CHAT_USER_ROUTE = "chat:day";

/** Signed-in users only see a "questions left" line once they're down to this many. */
export const CHAT_USER_LOW_QUOTA = 5;

/** ISO timestamp the current fixed window ends (next UTC midnight for a daily window) — matches consume_anon_rate_limit's and consume_rate_limit's floor(epoch/window)*window. */
export function anonWindowResetsAt(windowSeconds: number, now: number = Date.now()): string {
  return new Date((Math.floor(now / 1000 / windowSeconds) + 1) * windowSeconds * 1000).toISOString();
}
