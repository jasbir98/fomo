/**
 * Signed-out Ask Fomo allowance, shared by app/api/chat (enforces it) and
 * app/api/chat/quota (reports it) so the two can't drift apart.
 */

/** Signed-out visitors: 3 questions a day per IP, and no history is stored server-side. */
export const CHAT_ANON_DAILY_LIMIT = { limit: 3, windowSeconds: 24 * 60 * 60 };

/** `anon_rate_limits.route` for that allowance. */
export const CHAT_ANON_ROUTE = "chat:anon-day";

/** ISO timestamp the current fixed window ends (next UTC midnight for a daily window) — matches consume_anon_rate_limit's floor(epoch/window)*window. */
export function anonWindowResetsAt(windowSeconds: number, now: number = Date.now()): string {
  return new Date((Math.floor(now / 1000 / windowSeconds) + 1) * windowSeconds * 1000).toISOString();
}
