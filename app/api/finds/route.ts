/**
 * GET /api/finds -> FindsResponse (lib/finds/types.ts)
 *
 * The live Finds (the hand-approved steals list; "Fomo Finds" on Instagram,
 * surfaced in the app as "For you" at /for-you), joined to their
 * events/happenings, ended ones dropped, ordered by Fomo level then soonest.
 * The /finds page server-renders the same list via lib/finds/load.ts; this
 * route is for the client — the badge store (lib/finds/useFinds.ts) reads it
 * once per session to know which cards get a "Fomo Find" badge.
 *
 * Public: signed-out visitors see Finds too. proxy.ts lets an anonymous GET
 * through (PUBLIC_API_PREFIXES), and every read is `read_all` to anon under
 * RLS (finds: live rows only), so the cookie-less loader is enough.
 *
 * Cache: CACHE_SHORT (browser-only), deliberately NOT a public/s-maxage
 * preset. Every /api/* response can carry a refreshed session Set-Cookie that
 * proxy.ts injects (see the header of lib/http/cache.ts), so a shared-cache
 * header here could replay one visitor's cookie to another. The /finds page
 * itself is where the shared caching happens (revalidate on a timer).
 *
 * Never fails the caller: any error — including the finds table not existing
 * yet — is `{ items: [] }`, same contract as the other read-only routes.
 */
import "server-only";
import { loadLiveFinds } from "@/lib/finds/load";
import type { FindsResponse } from "@/lib/finds/types";
import { cachedJson, CACHE_SHORT } from "@/lib/http/cache";

export const runtime = "nodejs";

export async function GET() {
  try {
    return cachedJson<FindsResponse>({ items: await loadLiveFinds() }, CACHE_SHORT);
  } catch (err) {
    // loadLiveFinds never throws; this is belt-and-braces for the serialiser.
    console.error("[api/finds] failed", err);
    return cachedJson<FindsResponse>({ items: [] }, CACHE_SHORT);
  }
}
