import type { MetadataRoute } from "next";
import { supabaseAnon } from "@/lib/supabase/anon";
import { listLiveHappenings } from "@/lib/db/happenings";
import { listUpcomingEvents } from "@/lib/db/events";
import { happeningHasEnded } from "@/lib/happenings/occurrence";
import { SITE_URL } from "@/lib/seo/site";

// Public, indexable static pages — anything behind auth (signin/
// profile/fomo chat) or an API route is deliberately left out, matching
// app/robots.ts's disallow list.
//
// `changesWithCatalogue` pages list catalogue rows, so they last changed when
// the newest row did. The rest are hand-written: their date is when their
// content last changed (privacy/terms match the "Last updated" line on the
// page), bumped by hand with the page.
const STATIC_PAGES: { path: string; changesWithCatalogue?: true; lastModified?: string }[] = [
  { path: "/", changesWithCatalogue: true },
  { path: "/weekend", changesWithCatalogue: true },
  { path: "/kids", changesWithCatalogue: true },
  { path: "/for-you", changesWithCatalogue: true },
  { path: "/deals", changesWithCatalogue: true },
  { path: "/whats-on", changesWithCatalogue: true },
  { path: "/free", changesWithCatalogue: true },
  { path: "/book-early", changesWithCatalogue: true },
  { path: "/explore", changesWithCatalogue: true },
  { path: "/tip", lastModified: "2026-10-14" },
  { path: "/privacy", lastModified: "2026-10-14" },
  { path: "/terms", lastModified: "2026-10-05" },
];

// Hard ceiling so this can never grow past sitemap.xml's ~50k practical
// limit (or the "keep under 5k" ask here) as the catalog grows — split
// between the happening and event sections, plus a smaller one for venues.
const MAX_DYNAMIC_URLS = 4800;
const MAX_PLACE_URLS = 1000;

/** Keeps the later of two dates per key. */
function bumpLatest(map: Map<string, Date>, key: string, date: Date) {
  const current = map.get(key);
  if (!current || date > current) map.set(key, date);
}

/**
 * GET /sitemap.xml — static public pages plus every live happening, upcoming
 * event, and venue with something on (a live offer or an upcoming event), so
 * search engines can find detail pages without following in-app links. A
 * lookup failure degrades to just the static pages rather than 500ing the
 * whole sitemap.
 *
 * Built per request. It used to be hourly ISR, but the cached copy on
 * Vercel stopped refreshing (still the 10 Oct build on 12 Oct), so it
 * kept listing events that had ended, whose pages are noindex, and Search
 * Console reported them as "Excluded by 'noindex' tag". Crawlers fetch a
 * sitemap a few times a day, so a fresh read is cheap.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Cookie-less anon client: everything here is public catalogue data.
  const db = supabaseAnon();
  const now = new Date();

  const [happenings, events] = await Promise.all([
    listLiveHappenings(db).catch(() => []),
    listUpcomingEvents(db, { limit: MAX_DYNAMIC_URLS }).catch(() => []),
  ]);

  // A "live" row whose dated window has passed still has a page, but it isn't
  // worth a crawler's time (the page itself is noindex once ended).
  const liveHappenings = happenings.filter((happening) => !happeningHasEnded(happening, now));
  const happeningEntries: MetadataRoute.Sitemap = liveHappenings.slice(0, MAX_DYNAMIC_URLS / 2).map((happening) => ({
    url: `${SITE_URL}/happening/${happening.id}`,
    lastModified: happening.updated_at ? new Date(happening.updated_at) : now,
  }));

  const eventEntries: MetadataRoute.Sitemap = events.slice(0, MAX_DYNAMIC_URLS / 2).map((event) => ({
    url: `${SITE_URL}/event/${event.id}`,
    lastModified: event.fetched_at ? new Date(event.fetched_at) : now,
  }));

  // Venues worth a crawl: the ones a live offer or an upcoming event links to.
  // Every other place page is still reachable, just not pushed. `places` has
  // no updated_at, and what changes on a venue's page is its offers and
  // events, so its date is the newest of theirs.
  const placeDates = new Map<string, Date>();
  for (const happening of liveHappenings) {
    if (happening.place_id) bumpLatest(placeDates, happening.place_id, happening.updated_at ? new Date(happening.updated_at) : now);
  }
  for (const event of events) {
    if (event.place_id) bumpLatest(placeDates, event.place_id, event.fetched_at ? new Date(event.fetched_at) : now);
  }
  const placeEntries: MetadataRoute.Sitemap = Array.from(placeDates)
    .slice(0, MAX_PLACE_URLS)
    .map(([placeId, lastModified]) => ({ url: `${SITE_URL}/place/${placeId}`, lastModified }));

  // The newest catalogue row; `now` only when the lookups failed and there is none.
  const allDates = [...happeningEntries, ...eventEntries].map((e) => e.lastModified as Date);
  const catalogueDate = allDates.length > 0 ? new Date(Math.max(...allDates.map((d) => d.getTime()))) : now;
  const staticEntries: MetadataRoute.Sitemap = STATIC_PAGES.map((page) => ({
    url: `${SITE_URL}${page.path}`,
    lastModified: page.changesWithCatalogue ? catalogueDate : new Date(`${page.lastModified}T00:00:00Z`),
  }));

  return [...staticEntries, ...happeningEntries, ...eventEntries, ...placeEntries];
}
