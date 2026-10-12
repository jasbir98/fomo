import type { MetadataRoute } from "next";
import { supabaseAnon } from "@/lib/supabase/anon";
import { listLiveHappenings } from "@/lib/db/happenings";
import { listUpcomingEvents } from "@/lib/db/events";
import { happeningHasEnded } from "@/lib/happenings/occurrence";
import { SITE_URL } from "@/lib/seo/site";

// Public, indexable static pages — anything behind auth (signin/welcome/
// profile/fomo chat) or an API route is deliberately left out, matching
// app/robots.ts's disallow list.
const STATIC_PATHS = [
  "/",
  "/weekend",
  "/for-you",
  "/deals",
  "/whats-on",
  "/free",
  "/book-early",
  "/explore",
  "/tip",
  "/privacy",
  "/terms",
];

// Hard ceiling so this can never grow past sitemap.xml's ~50k practical
// limit (or the "keep under 5k" ask here) as the catalog grows — split
// roughly evenly between the two dynamic sections.
const MAX_DYNAMIC_URLS = 4800;

/**
 * GET /sitemap.xml — static public pages plus every live happening and
 * upcoming event, so search engines can find deal/event detail pages
 * without following in-app links. A lookup failure degrades to just the
 * static pages rather than 500ing the whole sitemap.
 *
 * Built per request. It used to be hourly ISR, but the cached copy on
 * Vercel stopped refreshing (still the 10 Oct build on 12 Oct), so it
 * kept listing events that had ended, whose pages are noindex, and Search
 * Console reported them as "Excluded by 'noindex' tag". Crawlers fetch a
 * sitemap a few times a day, so a fresh read is cheap.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.map((path) => ({
    url: `${SITE_URL}${path}`,
    lastModified: new Date(),
  }));

  // Cookie-less anon client: everything here is public catalogue data.
  const db = supabaseAnon();
  const now = new Date();

  const [happenings, events] = await Promise.all([
    listLiveHappenings(db).catch(() => []),
    listUpcomingEvents(db, { limit: MAX_DYNAMIC_URLS }).catch(() => []),
  ]);

  // A "live" row whose dated window has passed still has a page, but it isn't
  // worth a crawler's time (the page itself is noindex once ended).
  const happeningEntries: MetadataRoute.Sitemap = happenings
    .filter((happening) => !happeningHasEnded(happening, now))
    .slice(0, MAX_DYNAMIC_URLS / 2)
    .map((happening) => ({
      url: `${SITE_URL}/happening/${happening.id}`,
      lastModified: happening.updated_at ? new Date(happening.updated_at) : new Date(),
    }));

  const eventEntries: MetadataRoute.Sitemap = events
    .slice(0, MAX_DYNAMIC_URLS / 2)
    .map((event) => ({
      url: `${SITE_URL}/event/${event.id}`,
      lastModified: event.fetched_at ? new Date(event.fetched_at) : new Date(),
    }));

  return [...staticEntries, ...happeningEntries, ...eventEntries];
}
