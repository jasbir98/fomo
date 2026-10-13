/**
 * GET /api/finds -> FindsResponse (lib/finds/types.ts)
 *
 * The live Finds (the hand-approved steals list; "Fomo Finds" on Instagram,
 * surfaced in the app as "For you" at /for-you), joined to their
 * events/happenings, ended ones dropped, ordered by Fomo level then soonest.
 * The /for-you page server-renders the teaser of the same list via
 * lib/finds/load.ts; this route is for the client — the For you page fetches
 * the full list from it once signed in, and the badge store
 * (lib/finds/useFinds.ts) reads it once per session to know which cards get a
 * "Picked for you" badge.
 *
 * Account-only: the full list is for signed-in visitors. The session is
 * checked here (cookie session, `auth.getUser()`), and the list itself is read
 * with the service role (the `finds` table no longer lets `anon` read it, see
 * supabase/add_finds.sql). A signed-out caller gets only the teaser: the first
 * TEASER_COUNT picks plus `total`, the count of all live Finds, so the locked
 * card can say how many more there are. proxy.ts still lets an anonymous GET
 * through (PUBLIC_API_PREFIXES) so that teaser can load.
 *
 * Cache: CACHE_SHORT (browser-only), deliberately NOT a public/s-maxage
 * preset. Every /api/* response can carry a refreshed session Set-Cookie that
 * proxy.ts injects (see the header of lib/http/cache.ts), so a shared-cache
 * header here could replay one visitor's cookie to another — and here the body
 * also differs by session. `Vary: Cookie` keeps even the browser's own cache
 * from serving a signed-out teaser to a visitor who has since signed in. The
 * /for-you page is where the shared caching happens (revalidate on a timer),
 * and it only ever contains the teaser.
 *
 * Never fails the caller: any error — including the finds table not existing
 * yet — is `{ items: [], total: 0 }`, same contract as the other read-only
 * routes. A failed session check counts as signed out (the teaser), never as
 * signed in.
 */
import "server-only";
import { loadLiveFindsWithTotal } from "@/lib/finds/load";
import { TEASER_COUNT, type FindsResponse } from "@/lib/finds/types";
import { cachedJson, CACHE_SHORT } from "@/lib/http/cache";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

const HEADERS = { headers: { Vary: "Cookie" } };

async function isSignedIn(): Promise<boolean> {
  try {
    const { data } = await (await supabaseServer()).auth.getUser();
    return !!data.user;
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    const signedIn = await isSignedIn();
    const { items, total } = await loadLiveFindsWithTotal(signedIn ? {} : { limit: TEASER_COUNT });
    return cachedJson<FindsResponse>({ items, total }, CACHE_SHORT, HEADERS);
  } catch (err) {
    // loadLiveFindsWithTotal never throws; this is belt-and-braces for the serialiser.
    console.error("[api/finds] failed", err);
    return cachedJson<FindsResponse>({ items: [], total: 0 }, CACHE_SHORT, HEADERS);
  }
}
