/**
 * The feed for a statically rendered page's first paint.
 *
 * Home, Deals, Free and This weekend are client components that load their
 * list from GET /api/feed after mounting, so without this their HTML is a
 * skeleton, which is all a crawler reading the raw HTML sees. These pages
 * call `loadFeedForPage` at render time (cached and re-built on a timer, see
 * each page's `revalidate`) and hand the result to the client component as
 * its starting content; the client still fetches its own copy on mount.
 *
 * Built with the cookie-less anon client (every read is of live/active rows,
 * which anon may read under RLS) and a generic ranking (`who: []`), so the page stays static and
 * can be served from the cache instead of rendered per visitor.
 */
import "server-only";
import { supabaseAnon } from "@/lib/supabase/anon";
import { buildFeed } from "@/lib/happenings/build-feed";
import type { FeedResponse, FeedWindow } from "@/lib/happenings/feed-types";

/** Never throws: a failed build returns null and the page falls back to its normal client-side loading state. */
export async function loadFeedForPage(window: Exclude<FeedWindow, "book_early">): Promise<FeedResponse | null> {
  try {
    return await buildFeed(supabaseAnon(), { window, range: "all", price: "all", now: new Date(), who: [] });
  } catch (err) {
    console.error(`[seo] feed build for ${window} failed; page will load client-side`, err);
    return null;
  }
}
