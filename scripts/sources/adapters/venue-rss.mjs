/**
 * Generic venue RSS feed adapter. Add another venue by appending to
 * VENUE_RSS_FEEDS and giving it a thin adapter file (see sneakypetes.mjs).
 */

import { cleanDescription } from "../../lib/describe.mjs";
import { httpUrlOrNull } from "../../lib/http-url.mjs";
import { DESTINATION } from "../core/config.mjs";
import { politeFetch } from "../core/fetch.mjs";
import { canonicalUrl } from "../core/jsonld.mjs";
import { CATEGORY_STATS, classifyCategory, dedupeWithinSource, isOffWedge } from "../core/normalize.mjs";
import { emptyStats } from "../core/stats.mjs";

// --- venue RSS feed adapter (generic) ------------------------------------------
//
// Some venues run their event listings as a WordPress blog where each post's
// *scheduled publish date* is set to the gig's own date/time, rather than the
// post's authoring date — verified against Sneaky Pete's public `/feed`:
// every item's <pubDate> is the show night (spread out months into the
// future), not "when this post was written". This is a small, reusable RSS
// parser (title/link/pubDate/category/description) driven by a per-venue
// config list (VENUE_RSS_FEEDS below), so adding another venue that
// publishes the same way is a config entry, not a new adapter function.
//
// Researched-but-rejected sources for this same "student ticketing / venue
// feeds" scope (checked robots.txt + fetched the listing page/likely
// feed endpoints, no bypass attempted):
//   - Fixr (fixr.co): Cloudflare bot-challenge on every request ("Just a
//     moment..." interstitial, HTTP 403) — blocked, no bypass.
//   - EUSA / Edinburgh University Students' Association: robots.txt is
//     `User-agent: * / Disallow: /` with explicit per-bot Allow overrides
//     only for Googlebot/Bingbot/facebookexternalhit/Slurp/Baiduspider —
//     this bot isn't on that list, so robots disallows it outright.
//   - Heriot-Watt SU (hwunion.com): same platform + same robots.txt shape
//     as EUSA (only named-bot Allow groups, no generic `*` Allow); its
//     `/ents/eventlist` page is also fully client-rendered with no
//     JSON-LD/RSS/API reachable without executing JS, so it's a double
//     reject even setting robots aside.
//   - Napier SU (napierstudents.com): robots.txt itself is permissive, but
//     `/ents/eventlist/` is a fully client-rendered SPA — no JSON-LD, no
//     RSS, no JSON API endpoint found in the server-rendered HTML.
//   - Summerhall: every request (including /robots.txt) returns a
//     Cloudflare "Attention Required" challenge page (HTTP 403) — blocked.
//   - The Stand Comedy Club: listing page is a client-rendered SPA with no
//     JSON-LD Event data and no server-rendered per-show links to follow.
//   - Usher Hall: now redirects to cultureedinburgh.com, a heavyweight
//     (~3.4MB) client-rendered app with zero structured data (no JSON-LD,
//     no embedded JSON blob, no RSS) in the server-rendered HTML.
//   - The Queen's Hall: `/whats-on`'s only JSON-LD is a placeholder stub
//     (`{"@type":"Event","name":"What's on","endDate":""}` — the *page*
//     mislabeled as an Event, not real show data); `/rss.xml` exists but
//     its `<channel>` has zero `<item>`s.
//   - Traverse Theatre: listing and individual show pages only carry
//     venue/business schema (`EntertainmentBusiness`/`TouristAttraction`),
//     never an `Event`; no RSS/JSON feed of shows found (its `/blog/rss`
//     is a news blog, not show listings).
//   - Leith Theatre: Squarespace site; listing page has only generic
//     `LocalBusiness`/`WebSite` JSON-LD, no per-show `Event` objects; no
//     ICS/RSS/API event feed found.
//   - Cabaret Voltaire: listing page has only `Organization`/
//     `BreadcrumbList` JSON-LD, no `Event` objects, and no server-rendered
//     per-show links to follow (client-rendered listing).
//   - Capital Theatres (Festival Theatre / King's Theatre operator):
//     `/whats-on` has only `Organization`/`BreadcrumbList` JSON-LD, no
//     `Event` data; `/feed` and `/whats-on/rss` are real RSS feeds but
//     contain press/news posts ("Dr Harry Brunjes appointed as new
//     Chair..."), not show listings.
//   - Assembly Roxy: SPA that 200s (`text/html`) for *any* path — every
//     guessed feed/API endpoint (`/events.ics`, `/events.json`,
//     `/api/events`, etc.) came back as the same client-rendered shell,
//     not real data; homepage itself has zero JSON-LD.
//   - Filmhouse / Cameo: `filmhousecinema.com` doesn't resolve; the
//     historic `filmhouse.co.uk` domain now redirects to an unrelated
//     cinema chain (regmovies.com) — couldn't confidently locate either
//     venue's current listings page within scope.
//
// Only Sneaky Pete's (`sneakypetes.co.uk/feed`) checked out: real,
// structured, public, `Allow: /` in robots.txt, one show per RSS item.

export const VENUE_RSS_FEEDS = [
  {
    provider: "sneakypetes",
    feedUrl: "https://sneakypetes.co.uk/feed",
    // Sneaky Pete's own site never states its address/coordinates in the
    // feed — same as Skiddle/Ticketmaster rows already carry venue-supplied
    // location data these JSON-LD scrapes don't have from the page itself.
    venue: {
      venue_name: "Sneaky Pete's",
      address: "73 Cowgate, Edinburgh, EH1 1JW",
      city: "Edinburgh",
      lat: 55.9490,
      lng: -3.1878,
    },
    // RSS <category> -> Fomo category. Falls through to classifyCategory's
    // keyword fallback (title/description) for anything unmapped.
    categoryMap: { Gigs: "music", Clubs: "nightlife", Comedy: "comedy" },
  },
];

const RSS_ITEM_RE = /<item>([\s\S]*?)<\/item>/gi;
function rssTag(itemXml, tag) {
  const m = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return null;
  return m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}
function rssCategories(itemXml) {
  const out = [];
  const re = /<category[^>]*>([\s\S]*?)<\/category>/gi;
  let m;
  while ((m = re.exec(itemXml)) !== null) {
    out.push(m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim());
  }
  return out;
}
function decodeXmlEntities(s) {
  return s
    .replace(/&#8211;/g, "–")
    .replace(/&#8216;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8230;/g, "…")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

/** Collapses the runs of whitespace WordPress titles/descriptions sometimes carry over from copy-pasted formatting (e.g. "Wytch   for fans of…") into single spaces. Does not attempt to fix missing spaces in the source data itself (e.g. "Unitfor") — that's a venue-side typo, not something safe to guess-correct. */
function collapseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

/** Minimal RSS 2.0 <item> parser — title/link/guid/pubDate/category/description only, no XML library dependency (same reasoning as this file's regex-based JSON-LD extraction). */
export function extractRssItems(xml) {
  const items = [];
  let m;
  RSS_ITEM_RE.lastIndex = 0;
  while ((m = RSS_ITEM_RE.exec(xml)) !== null) {
    const itemXml = m[1];
    items.push({
      title: collapseWhitespace(decodeXmlEntities(rssTag(itemXml, "title") ?? "")),
      link: rssTag(itemXml, "link"),
      guid: rssTag(itemXml, "guid"),
      pubDate: rssTag(itemXml, "pubDate"),
      categories: rssCategories(itemXml),
      description: collapseWhitespace(decodeXmlEntities((rssTag(itemXml, "description") ?? "").replace(/<[^>]+>/g, "").trim())),
    });
  }
  return items;
}

/**
 * Sneaky Pete's titles run the act and a "for fans of…" tagline together,
 * often with no space ("The Empty Pagefor fans of.. Sonic Youth"). Keep the
 * act as the name and return the tagline separately.
 */
export function splitFansOf(title) {
  const t = title.trim();
  const m = t.match(/^(.*?)\s*for fans of\s*(?:\.{2,3}|…)?\s*(.*)$/i);
  if (!m || !m[1].trim()) return { name: t, fansOf: null };
  return { name: m[1].trim(), fansOf: m[2].trim() || null };
}

/** Maps one RSS item (an upcoming show, per this venue's publish-on-the-gig-date pattern) to the `events` upsert shape. */
export function mapVenueRssItem(item, { provider, feedUrl, destination, now, venue, categoryMap }) {
  const { name, fansOf } = splitFansOf(item.title ?? "");
  if (!name || !item.pubDate) return { row: null, reason: "invalid" };
  // RFC 822 pubDate always carries an explicit offset (RSS 2.0 spec) —
  // unlike Skiddle's undocumented bare-date fallback, safe to hand straight
  // to `new Date` regardless of host timezone.
  const startsAt = new Date(item.pubDate);
  if (Number.isNaN(startsAt.getTime())) return { row: null, reason: "invalid" };
  if (startsAt.getTime() < now.getTime()) return { row: null, reason: "past" };

  let eventUrl = item.link;
  try {
    eventUrl = new URL(item.link ?? feedUrl, feedUrl).toString();
  } catch {
    eventUrl = feedUrl;
  }
  // Prefer the permalink (`item.link`): canonicalUrl() strips query strings,
  // which is safe for path-based permalinks but would collapse every item's
  // WordPress guid (`https://site/?p=1234`, identity lives in the query
  // string) down to the same bare root URL — verified against this feed,
  // where that bug silently merged 18 of 20 distinct shows onto one ID.
  // Only fall back to the raw (untransformed) guid when there's no usable
  // link at all.
  const providerEventId = eventUrl !== feedUrl ? canonicalUrl(eventUrl) : item.guid || null;
  if (!providerEventId) return { row: null, reason: "invalid" };

  const mappedCategory = item.categories.map((c) => categoryMap?.[c]).find(Boolean) ?? "other";

  const row = {
    provider,
    provider_event_id: providerEventId,
    name,
    description: cleanDescription(item.description, { title: name, venueName: venue.venue_name }) ?? (fansOf ? `For fans of ${fansOf}.` : null),
    category: mappedCategory,
    image_url: null, // RSS <item> carries no reliable photo (no enclosure/media tag on this feed)
    ticket_url: httpUrlOrNull(eventUrl),
    starts_at: startsAt.toISOString(),
    ends_at: null,
    venue_name: venue.venue_name,
    address: venue.address ?? null,
    lat: venue.lat ?? null,
    lng: venue.lng ?? null,
    city: venue.city ?? "Edinburgh",
    country: "GB",
    is_free: null, // not stated in the feed
    price_from: null,
    currency: null,
    destination,
    source: "api",
    fetched_at: now.toISOString(),
  };
  return { row, reason: null };
}

/** Hard cap on feed pages per venue per run (~10 items each). */
const MAX_FEED_PAGES = 12;

export async function adapterVenueRssFeed(config, now) {
  const { provider, feedUrl, venue, categoryMap } = config;
  const stats = emptyStats();
  let rows = [];
  // WordPress feeds list the newest post first and only ~10 items per page,
  // and these venues date each post by its show date. So page 1 holds the
  // furthest-future gigs; page with `?paged=N` until a page reaches past
  // shows (everything after it is older still).
  for (let page = 1; page <= MAX_FEED_PAGES; page += 1) {
    const url = page === 1 ? feedUrl : `${feedUrl.replace(/\/?$/, "/")}?paged=${page}`;
    const result = await politeFetch(url);
    if (!result.ok) {
      // A 404 past the last page is the normal end of the feed.
      if (page > 1 && /HTTP 404/.test(result.reason ?? "")) break;
      if (result.reason === "robots_disallowed" || result.reason === "robots_unavailable") {
        stats.skipped.robots += 1;
      } else {
        stats.skipped.blocked += 1;
      }
      console.log(`  [${provider}] ${url} -> SKIPPED (${result.reason})`);
      break;
    }
    stats.fetched += 1;

    const items = extractRssItems(result.html);
    if (items.length === 0) break;
    let sawPast = false;
    for (const item of items) {
      stats.parsed += 1;
      const { row, reason } = mapVenueRssItem(item, { provider, feedUrl, destination: DESTINATION, now, venue, categoryMap });
      if (!row) {
        if (reason === "past") {
          stats.skipped.past += 1;
          sawPast = true;
        } else stats.skipped.invalid += 1;
        continue;
      }
      // Venue-supplied lat/lng is fixed and already Edinburgh — no notEdinburgh check needed.
      if (isOffWedge(row)) {
        stats.skipped.offWedge += 1;
        console.log(`    [${provider}] off-wedge, skipped: "${row.name}" @ ${row.starts_at}`);
        continue;
      }
      CATEGORY_STATS.before[row.category ?? "other"] = (CATEGORY_STATS.before[row.category ?? "other"] ?? 0) + 1;
      row.category = classifyCategory(row);
      CATEGORY_STATS.after[row.category ?? "other"] = (CATEGORY_STATS.after[row.category ?? "other"] ?? 0) + 1;
      rows.push(row);
      stats.kept += 1;
    }
    if (sawPast) break;
  }
  rows = dedupeWithinSource(rows);
  return { provider, rows, stats };
}
