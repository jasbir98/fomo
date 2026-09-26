#!/usr/bin/env node
/**
 * daily-sources.mjs — Tier-1 daily events ingest for Fomo (Edinburgh).
 *
 * WHY THIS EXISTS. `events` is a live-fetch-and-cache table (see
 * lib/events/getForDestination.ts): rows only ever land there as a
 * side-effect of a user's own request hitting Skiddle/Ticketmaster, capped
 * at one page (`limit`, previously 20 — see the fix in lib/events/index.ts)
 * per call, no pagination, gated by a 6h TTL. There is no proactive crawl.
 * That's structurally why only ~97 upcoming rows existed against a city with
 * thousands of events/month: coverage is bounded by which destinations users
 * happen to query, not by what's actually on.
 *
 * This script is the proactive half: it crawls four free, public sources
 * that already embed schema.org Event JSON-LD on their Edinburgh listing
 * pages (no paid API, no login, no scraping framework — same
 * fetch+parse-JSON-LD approach as scraper/weekly_edinburgh.py's
 * `direct_records()`, reimplemented here in JS since this needs to run in
 * GitHub Actions on plain Node, and upsert straight into `events` via
 * PostgREST), plus a proactive (paginated, 60-day-lookahead) pull of the
 * same two APIs `lib/events/` already calls live (Skiddle, Ticketmaster,
 * when SKIDDLE_API_KEY / TICKETMASTER_API_KEY are set — see SOURCES below),
 * and upserts normalized rows into `events`, keyed on
 * (provider, provider_event_id) — the same unique index Skiddle/Ticketmaster
 * already use, so a row already cached by a live user request and a row
 * found here for the same event just co-exist as two different provider
 * rows (cross-provider dedupe at read time already exists —
 * lib/happenings/merge-events.ts's `dedupeProviderEvents`), on top of this
 * script's own cross-source dedupe (see dedupeAcrossSources below) across
 * all seven sources before anything is upserted.
 *
 * SOURCES:
 *   luma         https://lu.ma/edinburgh                                    (~20 events; tech/startup/networking; free, public, JSON-LD)
 *   eventbrite   https://www.eventbrite.co.uk/d/united-kingdom--edinburgh/...  (discover pages, 20/page; free, public, JSON-LD)
 *   songkick     https://www.songkick.com/metro-areas/24551-uk-edinburgh    (gigs; NOT 24542, that's Birmingham; free, public, JSON-LD)
 *   allevents    https://allevents.in/edinburgh/all                         (leaks non-Edinburgh rows — geo-filtered below; free, public, JSON-LD)
 *   skiddle      Skiddle Events API, /events/search/ (needs SKIDDLE_API_KEY)
 *   ticketmaster Ticketmaster Discovery v2, /events.json (needs TICKETMASTER_API_KEY)
 *   sneakypetes  https://sneakypetes.co.uk/feed                             (venue RSS feed — see VENUE_RSS_FEEDS below for the many venues checked and rejected: no structured data, blocked, or robots-disallowed)
 *
 * Every row (from any of the seven sources) also gets: an "off-wedge" filter
 * (drops multi-day/excursion-style listings that don't fit Edinburgh
 * students/young professionals looking for tonight/this weekend — see
 * isOffWedge below) and a keyword-based category fallback for rows a
 * source's own type/segment/eventcode mapping left as "other" (see
 * classifyCategory below).
 *
 * POLITENESS. Applies to the four JSON-LD (HTML-scraped) sources only —
 * Skiddle/Ticketmaster are authenticated API calls, not page scrapes, so
 * robots.txt doesn't apply to them; they're still one sequential request at
 * a time, wrapped in the same try/catch-per-page safety and paginated with a
 * hard page cap (never an unbounded loop). For the JSON-LD sources:
 * robots.txt is fetched and evaluated once per hostname per run
 * (cached) before any page on that host is requested — group selection by
 * product-token match (falling back to `*`), longest-path Allow/Disallow
 * with `*`/`$` wildcards, and Crawl-delay (raises the per-host interval when
 * it asks for slower than our default). A disallowed URL is skipped and
 * logged as "robots_disallowed" — never fetched, never worked around. Unlike
 * scraper/weekly_edinburgh.py's robot_allows() (which fails OPEN on a
 * robots.txt fetch error, being a supervised, occasional run), this script
 * fails CLOSED: only a clean 404 means "no rules"; any other error/timeout
 * skips that whole host for the run ("robots_unavailable"). On top of that:
 * real, identifying User-Agent; ~1 request/sec per hostname; a 20s timeout
 * per request; every adapter and every individual page fetch is wrapped in
 * its own try/catch so one dead source/page never kills the run. A
 * 401/403/429/503 or a detected bot-challenge page is likewise treated as
 * "this source said no" and skipped outright — never retried.
 *
 * SAFETY. --dry-run is the default (matches scripts/sweep-happenings.mjs's
 * convention): prints per-source fetched/parsed/kept/skipped counts and 3
 * sample normalized rows per source, writes nothing. Pass --write to
 * actually upsert. Never deletes anything.
 *
 * Uses the Supabase REST API directly (not @supabase/supabase-js) — that
 * client's mandatory Realtime/WebSocket init throws under plain Node 20,
 * same reasoning as scripts/promote-japan-places.mjs and
 * scripts/sweep-happenings.mjs.
 *
 * Usage:
 *   node --env-file=.env.local scripts/daily-sources.mjs                # dry run, all sources
 *   node --env-file=.env.local scripts/daily-sources.mjs --write        # actually upsert
 *   node --env-file=.env.local scripts/daily-sources.mjs --only=luma,songkick
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to
 * --write (server-only — never NEXT_PUBLIC_ for the key itself). Dry runs
 * work without them; a warning is printed instead of failing, since a dry
 * run's whole point is to be inspectable without touching the DB.
 * Optional SKIDDLE_API_KEY / TICKETMASTER_API_KEY enable the two API
 * adapters; each is skipped with a log line (not a failure) when its key is
 * absent, in both dry-run and --write.
 */

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node --env-file=.env.local scripts/daily-sources.mjs [options]

Crawls lu.ma, Eventbrite, Songkick and allevents.in's Edinburgh listing pages
for schema.org Event JSON-LD, plus (when SKIDDLE_API_KEY / TICKETMASTER_API_KEY
are set) a proactive paginated pull of the Skiddle and Ticketmaster APIs, and
upserts normalized rows into \`events\`, deduped on (provider, provider_event_id).

Options:
  --dry-run       Print per-source counts + 3 sample rows, write nothing.
                   Default behavior when neither --dry-run nor --write is given.
  --write         Actually upsert into \`events\`.
  --only=a,b      Only run the named adapters (luma, eventbrite, songkick, allevents, skiddle, ticketmaster, sneakypetes).
  --skip=a,b      Skip the named adapters (same as DAILY_SOURCES_SKIP env var, comma-separated).
                   Eventbrite has been seen returning HTTP 405 to some datacenter IPs (e.g.
                   GitHub Actions runners) — if that happens on this workflow's runner,
                   set DAILY_SOURCES_SKIP=eventbrite there and run --only=eventbrite by hand
                   from an unaffected IP instead.

Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the env to --write.
Optional: SKIDDLE_API_KEY / TICKETMASTER_API_KEY to enable those two adapters
(each skips cleanly, logging why, when its key is missing).
`);
  process.exit(0);
}

const WRITE = process.argv.includes("--write");
const DRY_RUN = !WRITE;

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim())) : null;

const skipArg = process.argv.find((a) => a.startsWith("--skip="));
const SKIP = new Set(
  [
    ...(skipArg ? skipArg.slice("--skip=".length).split(",") : []),
    ...(process.env.DAILY_SOURCES_SKIP ? process.env.DAILY_SOURCES_SKIP.split(",") : []),
  ]
    .map((s) => s.trim())
    .filter(Boolean)
);

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (WRITE && (!SUPABASE_URL || !SERVICE_ROLE_KEY)) {
  console.error(
    "[daily-sources] --write requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. " +
      "Run with: node --env-file=.env.local scripts/daily-sources.mjs --write"
  );
  process.exit(1);
}
if (DRY_RUN && (!SUPABASE_URL || !SERVICE_ROLE_KEY)) {
  console.warn(
    "[daily-sources] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — dry run only, nothing would be written anyway."
  );
}

// A real, identifying UA — no personal contact info, just a project handle,
// per the "polite" brief. No secrets or user PII belong in an outbound
// request header.
const USER_AGENT =
  "FomoEdinburghBot/1.0 (+https://github.com/jasbir98/fomo; daily events ingest)";
// The "product token" robots.txt directives are matched against — the first
// word of USER_AGENT, lowercased, no version/comment.
const BOT_TOKEN = "fomoedinburghbot";

const REQUEST_TIMEOUT_MS = 20_000;
const PER_HOST_INTERVAL_MS = 1000; // ~1 req/sec per hostname, floor (Crawl-delay can raise it per host)

const EDINBURGH_CENTER = { lat: 55.9533, lng: -3.1883 };
const GEO_RADIUS_KM = 15;
const LOCALITY_KEYWORDS = [
  "edinburgh",
  "leith",
  "musselburgh",
  "portobello",
  "corstorphine",
  "morningside",
  "stockbridge",
  "newington",
  "tollcross",
  "haymarket",
  "dalry",
  "canonmills",
  "marchmont",
  "bruntsfield",
  "granton",
  "gorgie",
];

// Bot-challenge/interstitial markers — same reasoning and (mostly) same list
// as scraper/weekly_edinburgh.py's CHALLENGE_MARKERS: named vendor phrasing
// only, deliberately excludes bare "captcha"/"cloudflare" (too many false
// positives on ordinary pages that merely embed a vendor script).
const CHALLENGE_MARKERS = [
  "cf-chl-",
  "cf_chl_opt",
  "__cf_chl_rt_tk",
  "checking your browser before accessing",
  "just a moment...",
  "attention required! | cloudflare",
  "enable javascript and cookies to continue",
  "verify you are human",
  "verifying you are human",
  "request unsuccessful. incapsula",
  "sorry, you have been blocked",
  "unusual traffic from your computer network",
];

function looksLikeChallengePage(html) {
  const lowered = html.toLowerCase();
  if (CHALLENGE_MARKERS.some((marker) => lowered.includes(marker))) return true;
  // A suspiciously tiny body on an otherwise-normal response.
  if (html.length < 5_000) return true;
  return false;
}

// --- robots.txt compliance --------------------------------------------------
//
// Mirrors robot_allows() in scraper/weekly_edinburgh.py — same product-token
// matching and same "an unreadable robots.txt is not permission to bypass
// the page" stance — but this script diverges from that function on purpose
// in one place: weekly_edinburgh.py fails OPEN on any robots.txt fetch error
// (treats it as "no evidence of disallow"), because it's a human-supervised,
// occasional run. This script runs unattended on a daily cron, so it fails
// CLOSED instead — a robots.txt that can't be read for this host means that
// host is skipped for the whole run, not silently treated as wide open.
// Only a clean 404 (no robots.txt at all) is treated as "no rules".
//
// Deliberately no external dependency (no `robots-parser` package) — a
// small, direct implementation matching the semantics we need: group
// selection by longest-matching product token (falling back to `*`),
// longest-path Allow/Disallow match with `*`/`$` wildcard support (Google's
// documented extension, since real robots.txt files use them), and
// Crawl-delay.

const robotsCache = new Map(); // hostname -> Promise<RobotsResult>

function parseRobotsTxt(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);

  const groups = [];
  let current = null;
  let currentHasRule = false;

  for (const line of lines) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === "user-agent") {
      if (!current || currentHasRule) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
        currentHasRule = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "allow" || field === "disallow") {
      if (!current) continue;
      current.rules.push({ type: field, path: value });
      currentHasRule = true;
    } else if (field === "crawl-delay") {
      if (!current) continue;
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
      currentHasRule = true;
    }
    // sitemap / other fields: not relevant to fetch-permission, ignored.
  }
  return groups;
}

/** Pick the group whose product token best matches ours (longest specific match), else the `*` group, else null (no applicable rules). */
function selectRobotsGroup(groups, botToken) {
  let specific = null;
  let specificLen = -1;
  let wildcard = null;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a === "*") {
        if (!wildcard) wildcard = g;
        continue;
      }
      if (botToken.startsWith(a) && a.length > specificLen) {
        specific = g;
        specificLen = a.length;
      }
    }
  }
  return specific ?? wildcard ?? null;
}

/** robots.txt path pattern (supports `*` wildcard and trailing `$` anchor) -> RegExp. */
function robotsPatternToRegex(pattern) {
  let p = pattern;
  let endAnchor = false;
  if (p.endsWith("$")) {
    endAnchor = true;
    p = p.slice(0, -1);
  }
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${endAnchor ? "$" : ""}`);
}

/** Longest-match Allow/Disallow, ties won by Allow (Google's documented tie-break). */
function isAllowedByGroup(group, pathAndQuery) {
  if (!group || group.rules.length === 0) return true;
  let best = null;
  for (const rule of group.rules) {
    if (rule.type === "disallow" && rule.path === "") continue; // empty Disallow = no restriction from this rule
    if (!robotsPatternToRegex(rule.path).test(pathAndQuery)) continue;
    const len = rule.path.length;
    if (!best || len > best.length || (len === best.length && rule.type === "allow")) {
      best = { type: rule.type, length: len };
    }
  }
  return !best || best.type === "allow";
}

async function fetchRobotsForHost(origin, host) {
  const robotsUrl = `${origin}/robots.txt`;
  await waitForHostSlot(host, PER_HOST_INTERVAL_MS);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(robotsUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/plain,*/*" },
      signal: controller.signal,
    });
    if (res.status === 404) {
      return { failClosed: false, group: null, crawlDelay: null };
    }
    if (!res.ok) {
      console.log(`  [robots] ${robotsUrl} -> HTTP ${res.status} — failing closed for ${host} this run`);
      return { failClosed: true, group: null, crawlDelay: null };
    }
    const text = await res.text();
    const groups = parseRobotsTxt(text);
    const group = selectRobotsGroup(groups, BOT_TOKEN);
    return { failClosed: false, group, crawlDelay: group?.crawlDelay ?? null };
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timed out" : `network error: ${err.message}`;
    console.log(`  [robots] ${robotsUrl} -> ${reason} — failing closed for ${host} this run`);
    return { failClosed: true, group: null, crawlDelay: null };
  } finally {
    clearTimeout(timeout);
  }
}

/** Cached (once per host per run) robots.txt lookup + evaluation for `url`. */
async function getRobots(url) {
  const u = new URL(url);
  const host = u.hostname;
  if (!robotsCache.has(host)) {
    robotsCache.set(host, fetchRobotsForHost(`${u.protocol}//${u.hostname}`, host));
  }
  return robotsCache.get(host);
}

// --- polite fetch: robots.txt + per-host rate limit + timeout + challenge detection ---

const lastRequestAtByHost = new Map();

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits, if needed, so the next request to `host` is at least `intervalMs` after the last one, then reserves the slot. */
async function waitForHostSlot(host, intervalMs) {
  const last = lastRequestAtByHost.get(host) ?? 0;
  const wait = intervalMs - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastRequestAtByHost.set(host, Date.now());
}

async function politeFetch(url) {
  const u = new URL(url);
  const host = u.hostname;

  const robots = await getRobots(url);
  if (robots.failClosed) {
    return { ok: false, reason: "robots_unavailable" };
  }
  if (!isAllowedByGroup(robots.group, u.pathname + u.search)) {
    return { ok: false, reason: "robots_disallowed" };
  }

  // Crawl-delay (seconds, from robots.txt) overrides our default 1 req/sec
  // floor for this host when it asks for something slower.
  const intervalMs =
    robots.crawlDelay != null && robots.crawlDelay * 1000 > PER_HOST_INTERVAL_MS
      ? robots.crawlDelay * 1000
      : PER_HOST_INTERVAL_MS;
  await waitForHostSlot(host, intervalMs);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status === 503) {
      return { ok: false, reason: `blocked (HTTP ${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const html = await res.text();
    if (looksLikeChallengePage(html)) {
      return { ok: false, reason: "blocked/challenged (looks like an interstitial page)" };
    }
    return { ok: true, html, finalUrl: res.url || url };
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timed out" : `network error: ${err.message}`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

// --- shared schema.org JSON-LD extraction (mirrors scraper/weekly_edinburgh.py) ---

const JSON_LD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function extractJsonLdBlocks(html) {
  const blocks = [];
  let match;
  JSON_LD_RE.lastIndex = 0;
  while ((match = JSON_LD_RE.exec(html)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function* iterJsonObjects(value) {
  if (Array.isArray(value)) {
    for (const child of value) yield* iterJsonObjects(child);
  } else if (value && typeof value === "object") {
    yield value;
    for (const child of Object.values(value)) yield* iterJsonObjects(child);
  }
}

// Same vocabulary as scraper/weekly_edinburgh.py's EVENT_TYPES.
const EVENT_TYPES = new Set([
  "Event",
  "ScreeningEvent",
  "MusicEvent",
  "TheaterEvent",
  "Festival",
  "SocialEvent",
  "SportsEvent",
  "ExhibitionEvent",
  "EducationEvent",
  "FoodEvent",
  "ComedyEvent",
  "DanceEvent",
  "VisualArtsEvent",
  "LiteraryEvent",
  "ChildrensEvent",
  "BusinessEvent",
  "SaleEvent",
  "PublicationEvent",
  "BroadcastEvent",
  "CourseInstance",
]);

// Heuristic @type -> Fomo EventCategory (lib/events/categories.ts's
// vocabulary: music | nightlife | festival | arts | comedy | sports | food |
// family | other). No "nightlife" schema.org type exists, so that slug is
// unreachable from JSON-LD alone — same as Skiddle/Ticketmaster's own
// mappers, which also never guess nightlife from provider data.
const TYPE_TO_CATEGORY = {
  MusicEvent: "music",
  Festival: "festival",
  TheaterEvent: "arts",
  ExhibitionEvent: "arts",
  VisualArtsEvent: "arts",
  DanceEvent: "arts",
  LiteraryEvent: "arts",
  ComedyEvent: "comedy",
  SportsEvent: "sports",
  FoodEvent: "food",
  ChildrensEvent: "family",
};

function categoryFromTypes(types) {
  for (const t of types) {
    if (TYPE_TO_CATEGORY[t]) return TYPE_TO_CATEGORY[t];
  }
  return "other";
}

function isoFromJsonLd(value, { end = false } = {}) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T${end ? "23:59:59" : "00:00:00"}+00:00`;
  }
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : trimmed;
}

/** Extract {isFree, priceFrom, currency} from a JSON-LD Event's top-level isAccessibleForFree + offers. */
function parsePrice(obj) {
  if (obj.isAccessibleForFree === true || obj.isAccessibleForFree === "True" || obj.isAccessibleForFree === "https://schema.org/True") {
    return { isFree: true, priceFrom: 0, currency: null };
  }
  let offers = obj.offers;
  if (Array.isArray(offers)) offers = offers[0];
  if (!offers || typeof offers !== "object") return { isFree: null, priceFrom: null, currency: null };

  const rawPrice = offers.price ?? offers.lowPrice;
  const currency = typeof offers.priceCurrency === "string" ? offers.priceCurrency : null;
  if (rawPrice == null) return { isFree: null, priceFrom: null, currency };
  const value = Number(rawPrice);
  if (!Number.isFinite(value)) return { isFree: null, priceFrom: null, currency };
  return { isFree: value === 0, priceFrom: value, currency: value === 0 ? null : currency };
}

function addressFromLocation(location) {
  if (!location || typeof location !== "object") return { venueName: null, address: null, city: null, lat: null, lng: null };
  const venueName = typeof location.name === "string" ? location.name : null;
  let address = null;
  let city = null;
  const addr = location.address;
  if (typeof addr === "string") {
    address = addr;
  } else if (addr && typeof addr === "object") {
    city = typeof addr.addressLocality === "string" ? addr.addressLocality : null;
    address = [addr.streetAddress, addr.addressLocality, addr.postalCode].filter(Boolean).join(", ") || null;
  }
  let lat = null;
  let lng = null;
  const geo = location.geo;
  if (geo && typeof geo === "object") {
    const rawLat = geo.latitude;
    const rawLng = geo.longitude;
    if (rawLat != null && rawLng != null) {
      const nlat = Number(rawLat);
      const nlng = Number(rawLng);
      if (Number.isFinite(nlat) && Number.isFinite(nlng)) {
        lat = nlat;
        lng = nlng;
      }
    }
  }
  return { venueName, address, city, lat, lng };
}

function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    u.hostname = u.hostname.toLowerCase();
    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return `${u.protocol}//${u.hostname}${pathname}`;
  } catch {
    return url;
  }
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Convert one schema.org Event JSON-LD object to a normalized `events` row,
 * or null if it's missing what's needed for a stable key. Never throws —
 * bad/partial JSON-LD is common and just means "skip this object".
 */
function mapJsonLdEvent(obj, { provider, pageUrl, destination, now }) {
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const startsAtRaw = isoFromJsonLd(obj.startDate);
  if (!name || !startsAtRaw) return { row: null, reason: !name ? "no-name" : "no-start-date" };

  const startsAt = new Date(startsAtRaw);
  if (Number.isNaN(startsAt.getTime())) return { row: null, reason: "unparseable-start-date" };

  const endsAtRaw = isoFromJsonLd(obj.endDate, { end: true });
  const endsAt = endsAtRaw ? new Date(endsAtRaw) : null;
  const effectiveEnd = endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : startsAt;
  if (effectiveEnd.getTime() < now.getTime()) return { row: null, reason: "past" };

  const typeValue = obj["@type"];
  const types = Array.isArray(typeValue) ? typeValue : [typeValue];
  if (!types.some((t) => EVENT_TYPES.has(t))) return { row: null, reason: "not-an-event-type" };

  let eventUrl = typeof obj.url === "string" ? obj.url : typeof obj["@id"] === "string" ? obj["@id"] : pageUrl;
  try {
    eventUrl = new URL(eventUrl, pageUrl).toString();
  } catch {
    eventUrl = pageUrl;
  }
  const providerEventId = canonicalUrl(eventUrl);
  if (!providerEventId) return { row: null, reason: "no-stable-id" };

  const { venueName, address, city, lat, lng } = addressFromLocation(obj.location);
  const { isFree, priceFrom, currency } = parsePrice(obj);

  const row = {
    provider,
    provider_event_id: providerEventId,
    name,
    description: typeof obj.description === "string" ? obj.description.trim().slice(0, 2000) : null,
    category: categoryFromTypes(types),
    image_url: pickImage(obj.image),
    ticket_url: eventUrl,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt.toISOString() : null,
    venue_name: venueName,
    address,
    lat,
    lng,
    city,
    country: "GB",
    is_free: isFree,
    price_from: priceFrom,
    currency,
    destination,
    source: "api",
    fetched_at: now.toISOString(),
  };
  return { row, reason: null };
}

function pickImage(image) {
  if (typeof image === "string") return image;
  if (Array.isArray(image)) {
    const first = image.find((i) => typeof i === "string" || (i && typeof i === "object" && typeof i.url === "string"));
    if (typeof first === "string") return first;
    if (first && typeof first === "object") return first.url;
    return null;
  }
  if (image && typeof image === "object" && typeof image.url === "string") return image.url;
  return null;
}

function isEdinburghRow(row) {
  if (row.lat != null && row.lng != null) {
    if (haversineKm(EDINBURGH_CENTER, { lat: row.lat, lng: row.lng }) <= GEO_RADIUS_KM) return true;
  }
  const haystack = `${row.city ?? ""} ${row.address ?? ""}`.toLowerCase();
  return LOCALITY_KEYWORDS.some((k) => haystack.includes(k));
}

// --- category enhancement -----------------------------------------------------
//
// JSON-LD `@type` (via TYPE_TO_CATEGORY above), Skiddle's `eventcode` and
// Ticketmaster's `classifications[].segment.name` are each a source's own
// specific category signal and always win when present (an actual
// ComedyEvent/MusicEvent/etc., or an actual Skiddle "COMEDY"/"CLUB" code, is
// more trustworthy than a keyword guess). But most listing-page JSON-LD uses
// the generic `Event`/`SocialEvent` type, which TYPE_TO_CATEGORY can't map,
// so those — and anything else that fell through to "other" — get a second
// pass here: a keyword classifier over name + venue + description, mapped
// only onto lib/events/categories.ts's real EventCategory slugs (music |
// nightlife | festival | arts | comedy | sports | food | family | other) —
// no new slugs invented. Checked in priority order; first match wins.
const CATEGORY_KEYWORD_RULES = [
  {
    category: "comedy",
    keywords: ["comedy night", "comedy show", "stand-up", "standup", "open mic comedy", "improv comedy", "comedian"],
    venues: ["monkey barrel", "the stand", "gilded balloon"],
  },
  {
    category: "nightlife",
    keywords: [
      "club night", "clubnight", "dj set", "all night rave", "rave", "afterparty", "after party",
      "techno night", "house night", "warehouse party", "nightclub",
    ],
  },
  {
    category: "sports",
    keywords: [
      "5-a-side", "five-a-side", "football match", "rugby match", "parkrun", "running club",
      "fun run", "5k run", "10k run", "sports club", "match day",
    ],
  },
  {
    category: "food",
    keywords: [
      "oktoberfest", "tasting", "brunch", "supper club", "food festival", "beer festival",
      "wine tasting", "gin tasting", "whisky tasting", "pop-up restaurant", "food market", "street food",
    ],
  },
  {
    category: "family",
    keywords: ["kids", "children's", "family fun", "family friendly", "toddler"],
  },
  {
    category: "arts",
    keywords: [
      "ceilidh", "barn dance", "ceilidh dance",
      "theatre", "panto", "pantomime", "play", "musical",
      "film screening", "cinema", "movie night", "screening",
      "exhibition", "art show", "gallery", "private view",
    ],
  },
  {
    category: "music",
    keywords: ["gig", "live music", "live at", "acoustic set", "concert", "open mic", "jam session", "dj night"],
  },
];

/**
 * Keyword fallback for rows whose category is still "other" after the
 * source's own specific-type mapping. Never downgrades a category a source
 * already assigned with confidence.
 */
function classifyCategory(row) {
  if (row.category && row.category !== "other") return row.category;
  const haystack = `${row.name ?? ""} ${row.venue_name ?? ""} ${row.description ?? ""}`.toLowerCase();
  for (const rule of CATEGORY_KEYWORD_RULES) {
    if (rule.venues?.some((v) => haystack.includes(v))) return rule.category;
    if (rule.keywords.some((k) => haystack.includes(k))) return rule.category;
  }
  return "other";
}

// --- off-wedge filter ----------------------------------------------------------
//
// The wedge is Edinburgh students/young professionals looking for something
// to do tonight/this weekend — not multi-day excursions that leave the city.
// Conservative on purpose: only drops rows with an explicit "this leaves
// Edinburgh" signal, or a genuinely long+pricey span (a >2-day event priced
// over £60 reads as a package/festival-pass/excursion, not a single outing).
const OFF_WEDGE_KEYWORDS = [
  "weekend trip", "day trip to", "day trip:", "multi-day tour", "multi day tour",
  "highlands tour", "tour of the highlands", "highland tour", "isle of skye", "isle of mull",
  "isle of arran", "isle of harris", "outer hebrides", "loch ness tour", "excursion to",
  "orkney tour", "shetland tour", "glencoe tour", "nc500", "north coast 500",
];

function isOffWedge(row) {
  const haystack = `${row.name ?? ""} ${row.description ?? ""}`.toLowerCase();
  if (OFF_WEDGE_KEYWORDS.some((k) => haystack.includes(k))) return true;
  if (row.ends_at) {
    const spanDays = (new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) / (1000 * 60 * 60 * 24);
    if (spanDays > 2 && (row.price_from ?? 0) > 60) return true;
  }
  return false;
}

/**
 * Fetch a page and extract normalized rows from its JSON-LD Event objects.
 * Returns per-page stats plus the rows. Never throws.
 */
async function fetchAndExtract(url, { provider, destination, now, requireEdinburgh }) {
  const stats = { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0, offWedge: 0 } };
  const result = await politeFetch(url);
  if (!result.ok) {
    if (result.reason === "robots_disallowed" || result.reason === "robots_unavailable") {
      stats.skipped.robots += 1;
    } else {
      stats.skipped.blocked += 1;
    }
    console.log(`  [${provider}] ${url} -> SKIPPED (${result.reason})`);
    return { rows: [], stats };
  }
  stats.fetched += 1;

  const blocks = extractJsonLdBlocks(result.html);
  const rawObjects = [];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      rawObjects.push(...iterJsonObjects(parsed));
    } catch {
      // Malformed JSON-LD block — skip just this block, not the whole page.
      continue;
    }
  }

  const rows = [];
  for (const obj of rawObjects) {
    const typeValue = obj["@type"];
    const types = Array.isArray(typeValue) ? typeValue : [typeValue];
    if (!types.some((t) => EVENT_TYPES.has(t))) continue;
    stats.parsed += 1;

    const { row, reason } = mapJsonLdEvent(obj, { provider, pageUrl: result.finalUrl, destination, now });
    if (!row) {
      if (reason === "past") stats.skipped.past += 1;
      else stats.skipped.invalid += 1;
      continue;
    }
    if (requireEdinburgh && !isEdinburghRow(row)) {
      stats.skipped.notEdinburgh += 1;
      continue;
    }
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
  return { rows, stats };
}

function mergeStats(a, b) {
  return {
    fetched: a.fetched + b.fetched,
    parsed: a.parsed + b.parsed,
    kept: a.kept + b.kept,
    skipped: {
      past: a.skipped.past + b.skipped.past,
      invalid: a.skipped.invalid + b.skipped.invalid,
      notEdinburgh: a.skipped.notEdinburgh + b.skipped.notEdinburgh,
      robots: a.skipped.robots + b.skipped.robots,
      blocked: a.skipped.blocked + b.skipped.blocked,
      offWedge: a.skipped.offWedge + b.skipped.offWedge,
    },
  };
}

/** Dedupe rows within one source's own run, keyed on provider_event_id (the same field the DB unique index uses). */
function dedupeWithinSource(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.provider_event_id)) byId.set(row.provider_event_id, row);
  }
  return Array.from(byId.values());
}

const DESTINATION = "Edinburgh, Scotland, United Kingdom";

// Category distribution before/after the keyword-classifier fallback, across
// every adapter (JSON-LD, Skiddle, Ticketmaster) — printed in the final
// summary so the effect of classifyCategory() is visible on every run.
const CATEGORY_STATS = { before: {}, after: {} };

// --- adapters ----------------------------------------------------------------

async function adapterLuma(now) {
  const provider = "luma";
  const pages = ["https://lu.ma/edinburgh"];
  let stats = { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0, offWedge: 0 } };
  let rows = [];
  for (const url of pages) {
    try {
      const r = await fetchAndExtract(url, { provider, destination: DESTINATION, now, requireEdinburgh: false });
      stats = mergeStats(stats, r.stats);
      rows.push(...r.rows);
    } catch (err) {
      console.error(`  [${provider}] ${url} -> ERROR: ${err.message}`);
    }
  }
  rows = dedupeWithinSource(rows);
  return { provider, rows, stats };
}

async function adapterEventbrite(now) {
  const provider = "eventbrite";
  const pages = [
    "https://www.eventbrite.co.uk/d/united-kingdom--edinburgh/free--events/",
    "https://www.eventbrite.co.uk/d/united-kingdom--edinburgh/free--events/?page=2",
    "https://www.eventbrite.co.uk/d/united-kingdom--edinburgh/events--this-weekend/",
  ];
  let stats = { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0, offWedge: 0 } };
  let rows = [];
  for (const url of pages) {
    try {
      const r = await fetchAndExtract(url, { provider, destination: DESTINATION, now, requireEdinburgh: false });
      stats = mergeStats(stats, r.stats);
      rows.push(...r.rows);
    } catch (err) {
      console.error(`  [${provider}] ${url} -> ERROR: ${err.message}`);
    }
  }
  rows = dedupeWithinSource(rows);
  return { provider, rows, stats };
}

async function adapterSongkick(now) {
  const provider = "songkick";
  const pages = ["https://www.songkick.com/metro-areas/24551-uk-edinburgh"];
  let stats = { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0, offWedge: 0 } };
  let rows = [];
  for (const url of pages) {
    try {
      const r = await fetchAndExtract(url, { provider, destination: DESTINATION, now, requireEdinburgh: false });
      stats = mergeStats(stats, r.stats);
      rows.push(...r.rows);
    } catch (err) {
      console.error(`  [${provider}] ${url} -> ERROR: ${err.message}`);
    }
  }
  rows = dedupeWithinSource(rows);
  return { provider, rows, stats };
}

async function adapterAllevents(now) {
  const provider = "allevents";
  const pages = ["https://allevents.in/edinburgh/all"];
  let stats = { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0, offWedge: 0 } };
  let rows = [];
  for (const url of pages) {
    try {
      // allevents.in is known to leak non-Edinburgh rows onto this page —
      // geo-filter (lat/lng within 15km of Edinburgh centre, or a known
      // locality name in city/address) is required for this adapter only.
      const r = await fetchAndExtract(url, { provider, destination: DESTINATION, now, requireEdinburgh: true });
      stats = mergeStats(stats, r.stats);
      rows.push(...r.rows);
    } catch (err) {
      console.error(`  [${provider}] ${url} -> ERROR: ${err.message}`);
    }
  }
  rows = dedupeWithinSource(rows);
  return { provider, rows, stats };
}

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

const VENUE_RSS_FEEDS = [
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
function extractRssItems(xml) {
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

/** Maps one RSS item (an upcoming show, per this venue's publish-on-the-gig-date pattern) to the `events` upsert shape. */
function mapVenueRssItem(item, { provider, feedUrl, destination, now, venue, categoryMap }) {
  const name = item.title?.trim();
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
    description: item.description ? item.description.slice(0, 2000) : null,
    category: mappedCategory,
    image_url: null, // RSS <item> carries no reliable photo (no enclosure/media tag on this feed)
    ticket_url: eventUrl,
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

async function adapterVenueRssFeed(config, now) {
  const { provider, feedUrl, venue, categoryMap } = config;
  const stats = { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0, offWedge: 0 } };
  let rows = [];
  const result = await politeFetch(feedUrl);
  if (!result.ok) {
    if (result.reason === "robots_disallowed" || result.reason === "robots_unavailable") {
      stats.skipped.robots += 1;
    } else {
      stats.skipped.blocked += 1;
    }
    console.log(`  [${provider}] ${feedUrl} -> SKIPPED (${result.reason})`);
    return { provider, rows, stats };
  }
  stats.fetched += 1;

  const items = extractRssItems(result.html);
  for (const item of items) {
    stats.parsed += 1;
    const { row, reason } = mapVenueRssItem(item, { provider, feedUrl, destination: DESTINATION, now, venue, categoryMap });
    if (!row) {
      if (reason === "past") stats.skipped.past += 1;
      else stats.skipped.invalid += 1;
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
  rows = dedupeWithinSource(rows);
  return { provider, rows, stats };
}

async function adapterSneakyPetes(now) {
  return adapterVenueRssFeed(VENUE_RSS_FEEDS.find((f) => f.provider === "sneakypetes"), now);
}

// --- Skiddle / Ticketmaster proactive refresh ---------------------------------
//
// lib/events/skiddle.ts and lib/events/ticketmaster.ts are only ever called
// live, from getEventsForDestination(), one page at a time, gated behind a
// user actually requesting Edinburgh. This is the proactive half for those
// two APIs too: the same field mapping (so provider_event_id — and every
// other column — comes out byte-identical to what a live request would
// write), but paginated over a 60-day window instead of one capped page.
// Because the (provider, provider_event_id) unique index is exactly what
// lib/events/getForDestination.ts's own upsert conflicts on, a row this
// script writes today and a row a live user request writes tomorrow for the
// same event upsert onto the same row rather than duplicating it.

const PROACTIVE_LOOKAHEAD_DAYS = 60;
const PROACTIVE_RADIUS_MILES = 10; // brief: "Edinburgh ... radius ~10 miles"

const SKIDDLE_EVENTCODE_MAP = {
  CLUB: "nightlife",
  LIVE: "music",
  FEST: "festival",
  THEATRE: "arts",
  ARTS: "arts",
  EXHIB: "arts",
  COMEDY: "comedy",
  DATE: "food",
  KIDS: "family",
  SPORT: "sports",
};
function categoryFromSkiddleCode(raw) {
  if (!raw) return "other";
  return SKIDDLE_EVENTCODE_MAP[String(raw).toUpperCase().trim()] ?? "other";
}

const TICKETMASTER_SEGMENT_MAP = {
  Music: "music",
  Sports: "sports",
  "Arts & Theatre": "arts",
  Film: "arts",
  Miscellaneous: "other",
};
function categoryFromTicketmasterSegment(raw) {
  if (!raw) return "other";
  return TICKETMASTER_SEGMENT_MAP[String(raw).trim()] ?? "other";
}

// Same placeholder-image filter as lib/events/skiddle.ts's realSkiddleImage —
// Skiddle serves a generic "no photo" CDN graphic for events/venues with no
// uploaded image; treat it as no image rather than a usable photo.
const SKIDDLE_PLACEHOLDER_IMAGE = /\/assets\/default\d*\.png$/i;
function realSkiddleImage(url) {
  if (!url || SKIDDLE_PLACEHOLDER_IMAGE.test(url)) return null;
  return url;
}

// Europe/London's UTC offset (0 in GMT, 60 in BST) for the given instant,
// computed via Intl rather than a hardcoded date range so it's correct
// across DST transitions in any year, and independent of the *host*
// machine's own timezone (unlike `new Date("YYYY-MM-DDTHH:mm:ss")`, which
// silently parses as host-local time — fine on a UTC CI runner most of the
// year, wrong by up to several hours run anywhere else, e.g. this repo's
// dev machines).
function londonOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUtc - date.getTime()) / 60_000;
}

/**
 * Skiddle's docs describe dates as "YYYY-MM-DD HH:mm:ss" with no timezone
 * (UK local) — but the live /events/search/ response actually returns full
 * ISO 8601 with an explicit offset (e.g. "2026-10-01T19:00:00+00:00", and
 * that offset is genuinely the UTC instant, not a mislabeled local time —
 * verified against the live API: autumn evening gigs came back with a UTC
 * hour consistent with a ~7-8pm BST local start). Handle both: an explicit
 * offset/Z is trusted as-is (`new Date` parses it correctly regardless of
 * host timezone); only the undocumented-but-possible bare
 * "YYYY-MM-DD HH:mm:ss" form (no offset) is treated as Europe/London wall
 * time and converted, since `new Date("YYYY-MM-DDTHH:mm:ss")` would
 * otherwise silently parse as the *host* machine's local timezone.
 */
function parseSkiddleDate(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  // First guess the wall-clock time is UTC, find what Europe/London offset
  // is in effect at that instant, then correct — self-consistent because
  // the offset only flips on DST transition dates at 1/2am local, never at
  // the same wall-clock reading under both offsets.
  const guessUtcMs = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetMin = londonOffsetMinutes(new Date(guessUtcMs));
  const dt = new Date(guessUtcMs - offsetMin * 60_000);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function parseSkiddlePrice(raw) {
  if (!raw) return { isFree: null, priceFrom: null };
  const trimmed = String(raw).trim();
  if (/free/i.test(trimmed)) return { isFree: true, priceFrom: 0 };
  const match = trimmed.match(/[\d.]+/);
  if (!match) return { isFree: null, priceFrom: null };
  const value = Number(match[0]);
  return { isFree: false, priceFrom: Number.isFinite(value) ? value : null };
}

/** Mirrors lib/events/skiddle.ts's mapEvent() exactly — same fields, same provider_event_id shape (String(event.id), no transformation). */
function mapSkiddleEvent(event, { destination, now }) {
  const id = event.id != null ? String(event.id) : null;
  const starts_at = parseSkiddleDate(event.startdate);
  if (!id || !event.eventname || !starts_at) return { row: null, reason: "invalid" };
  const startDate = new Date(starts_at);
  const ends_at = parseSkiddleDate(event.enddate);
  const effectiveEnd = ends_at ? new Date(ends_at) : startDate;
  if (effectiveEnd.getTime() < now.getTime()) return { row: null, reason: "past" };

  const lat = event.venue?.latitude ?? event.latitude;
  const lng = event.venue?.longitude ?? event.longitude;
  const { isFree, priceFrom } = parseSkiddlePrice(event.entryprice);

  const row = {
    provider: "skiddle",
    provider_event_id: id,
    name: event.eventname,
    description: event.description ?? null,
    category: categoryFromSkiddleCode(event.eventcode),
    image_url: realSkiddleImage(event.largeimageurl) ?? realSkiddleImage(event.imageurl),
    ticket_url: event.link ?? event.admin?.link ?? null,
    starts_at,
    ends_at,
    venue_name: event.venue?.name ?? null,
    address: [event.venue?.address, event.venue?.town].filter(Boolean).join(", ") || null,
    lat: lat != null ? Number(lat) : null,
    lng: lng != null ? Number(lng) : null,
    city: event.venue?.town ?? null,
    country: "GB",
    is_free: isFree,
    price_from: priceFrom,
    currency: isFree ? null : event.currency ?? "GBP",
    destination,
    source: "api",
    fetched_at: now.toISOString(),
  };
  return { row, reason: null };
}

async function adapterSkiddle(now) {
  const provider = "skiddle";
  const stats = { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0, offWedge: 0 } };
  const apiKey = process.env.SKIDDLE_API_KEY;
  if (!apiKey) {
    console.log(`  [${provider}] SKIPPED (no SKIDDLE_API_KEY in env)`);
    return { provider, rows: [], stats };
  }

  const minDate = now.toISOString().slice(0, 10);
  const maxDate = new Date(now.getTime() + PROACTIVE_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const limit = 100;
  const MAX_PAGES = 15; // safety cap: 1500 events, comfortably above Edinburgh's 60-day volume
  let rows = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      api_key: apiKey,
      latitude: String(EDINBURGH_CENTER.lat),
      longitude: String(EDINBURGH_CENTER.lng),
      radius: String(PROACTIVE_RADIUS_MILES),
      order: "date",
      description: "1",
      limit: String(limit),
      offset: String(offset),
      country: "GB",
      minDate,
      maxDate,
    });
    let res;
    try {
      res = await fetch(`https://www.skiddle.com/api/v1/events/search/?${params.toString()}`);
    } catch (err) {
      console.error(`  [${provider}] offset=${offset} -> network error: ${err.message}`);
      break;
    }
    if (!res.ok) {
      console.log(`  [${provider}] offset=${offset} -> HTTP ${res.status}`);
      break;
    }
    let data;
    try {
      data = await res.json();
    } catch (err) {
      console.error(`  [${provider}] offset=${offset} -> bad JSON: ${err.message}`);
      break;
    }
    if (data.error) {
      console.log(`  [${provider}] offset=${offset} -> api error: ${data.error}`);
      break;
    }
    stats.fetched += 1;
    const results = data.results ?? [];
    for (const e of results) {
      stats.parsed += 1;
      const { row, reason } = mapSkiddleEvent(e, { destination: DESTINATION, now });
      if (!row) {
        if (reason === "past") stats.skipped.past += 1;
        else stats.skipped.invalid += 1;
        continue;
      }
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
    if (results.length < limit) break; // last page
    offset += limit;
  }
  rows = dedupeWithinSource(rows);
  return { provider, rows, stats };
}

// Minimal lat/lng -> geohash encoder for Ticketmaster Discovery v2's
// `geoPoint` param — same standard base32 geohash algorithm as
// lib/events/geohash.ts's encodeGeohash(), reimplemented here since this
// script is plain Node with no `@/` import alias.
const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
function encodeGeohash(lat, lng, precision = 9) {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let hash = "";
  let bit = 0;
  let ch = 0;
  let evenBit = true;
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { ch = (ch << 1) | 1; lngMin = mid; } else { ch = ch << 1; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latMin = mid; } else { ch = ch << 1; latMax = mid; }
    }
    evenBit = !evenBit;
    if (++bit === 5) { hash += GEOHASH_BASE32[ch]; bit = 0; ch = 0; }
  }
  return hash;
}

/** Pick the widest available image, preferring 16:9 — same as lib/events/ticketmaster.ts's pickImage(). */
function pickTmImage(images) {
  if (!images || images.length === 0) return null;
  const sixteenByNine = images.filter((i) => i.ratio === "16_9");
  const pool = sixteenByNine.length > 0 ? sixteenByNine : images;
  const widest = [...pool].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return widest?.url ?? null;
}

/** Mirrors lib/events/ticketmaster.ts's mapEvent() exactly — provider_event_id is event.id, untransformed. */
function mapTicketmasterEvent(event, { destination, now }) {
  const id = event.id;
  const starts_at = event.dates?.start?.dateTime;
  if (!id || !event.name || !starts_at) return { row: null, reason: "invalid" };
  const startDate = new Date(starts_at);
  if (Number.isNaN(startDate.getTime())) return { row: null, reason: "invalid" };
  if (startDate.getTime() < now.getTime()) return { row: null, reason: "past" };

  const venue = event._embedded?.venues?.[0];
  const lat = venue?.location?.latitude != null ? Number(venue.location.latitude) : null;
  const lng = venue?.location?.longitude != null ? Number(venue.location.longitude) : null;
  const segmentName = event.classifications?.[0]?.segment?.name;
  const price = event.priceRanges?.[0];

  const row = {
    provider: "ticketmaster",
    provider_event_id: id,
    name: event.name,
    description: event.info ?? event.pleaseNote ?? null,
    category: categoryFromTicketmasterSegment(segmentName),
    image_url: pickTmImage(event.images),
    ticket_url: event.url ?? null,
    starts_at,
    ends_at: null,
    venue_name: venue?.name ?? null,
    address: [venue?.address?.line1, venue?.city?.name].filter(Boolean).join(", ") || null,
    lat: lat != null && Number.isFinite(lat) ? lat : null,
    lng: lng != null && Number.isFinite(lng) ? lng : null,
    city: venue?.city?.name ?? null,
    country: venue?.country?.countryCode ?? null,
    is_free: null,
    price_from: typeof price?.min === "number" ? price.min : null,
    currency: price?.currency ?? null,
    destination,
    source: "api",
    fetched_at: now.toISOString(),
  };
  return { row, reason: null };
}

function toTmDateTime(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function adapterTicketmaster(now) {
  const provider = "ticketmaster";
  const stats = { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0, offWedge: 0 } };
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) {
    console.log(`  [${provider}] SKIPPED (no TICKETMASTER_API_KEY in env)`);
    return { provider, rows: [], stats };
  }

  const startDateTime = toTmDateTime(now);
  const endDateTime = toTmDateTime(new Date(now.getTime() + PROACTIVE_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000));
  const size = 100;
  const MAX_PAGES = 15;
  let rows = [];
  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
    const params = new URLSearchParams({
      apikey: apiKey,
      geoPoint: encodeGeohash(EDINBURGH_CENTER.lat, EDINBURGH_CENTER.lng, 9),
      radius: String(Math.round(PROACTIVE_RADIUS_MILES * 1.60934)), // TM's `unit` param below is km
      unit: "km",
      size: String(size),
      page: String(pageNum),
      sort: "date,asc",
      startDateTime,
      endDateTime,
    });
    let res;
    try {
      res = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params.toString()}`);
    } catch (err) {
      console.error(`  [${provider}] page=${pageNum} -> network error: ${err.message}`);
      break;
    }
    if (!res.ok) {
      // TM returns 401/403 for a bad key — treated the same as "this source said no", no retry.
      console.log(`  [${provider}] page=${pageNum} -> HTTP ${res.status}`);
      break;
    }
    let data;
    try {
      data = await res.json();
    } catch (err) {
      console.error(`  [${provider}] page=${pageNum} -> bad JSON: ${err.message}`);
      break;
    }
    stats.fetched += 1;
    const events = data._embedded?.events ?? [];
    for (const e of events) {
      stats.parsed += 1;
      const { row, reason } = mapTicketmasterEvent(e, { destination: DESTINATION, now });
      if (!row) {
        if (reason === "past") stats.skipped.past += 1;
        else stats.skipped.invalid += 1;
        continue;
      }
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
    const totalPages = data.page?.totalPages ?? 1;
    if (pageNum + 1 >= totalPages || events.length === 0) break;
  }
  rows = dedupeWithinSource(rows);
  return { provider, rows, stats };
}

const ADAPTERS = {
  luma: adapterLuma,
  eventbrite: adapterEventbrite,
  songkick: adapterSongkick,
  allevents: adapterAllevents,
  skiddle: adapterSkiddle,
  ticketmaster: adapterTicketmaster,
  sneakypetes: adapterSneakyPetes,
};

// --- cross-source merge + upsert ----------------------------------------------

// en-CA gives YYYY-MM-DD directly — used to key on the event's Europe/London
// calendar date rather than the raw (often UTC) starts_at timestamp, so an
// 11pm-local gig doesn't key onto the next UTC day.
const LONDON_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function londonDateKey(iso) {
  try {
    return LONDON_DATE_FMT.format(new Date(iso));
  } catch {
    return String(iso).slice(0, 10);
  }
}

const LONDON_HOUR_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hourCycle: "h23",
  hour: "2-digit",
});
// Coarse (3h) time-of-day bucket, Europe/London local hour. Tolerates the
// few-minutes showtime discrepancies different sources report for the same
// real event, while still telling apart a same-day matinee (e.g. 13:30) from
// an evening show (e.g. 18:30) of a touring production at the same venue —
// title+date+venue alone can't distinguish those.
function londonHourBucket(iso) {
  try {
    const hour = Number(LONDON_HOUR_FMT.format(new Date(iso)));
    return Math.floor(hour / 3);
  } catch {
    return "?";
  }
}

function stripDiacritics(s) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/**
 * Normalize a title for cross-source identity matching: strip the trailing
 * venue/qualifier noise each source tacks onto the same event's name
 * differently ("Walter Trout // Edinburgh Queens Hall" vs "Walter Trout @
 * Queen's Hall" vs "Walter Trout - Edinburgh" vs "Walter Trout (Edinburgh)"),
 * fold accents (Angèle -> angele) so different sources' encodings of the same
 * name match, and collapse punctuation/whitespace. This runs on every row
 * before keying — JSON-LD sources and the Skiddle/Ticketmaster proactive
 * rows alike — so a gig discovered by both a scrape and a provider API
 * collapses onto one row too.
 */
function normalizeEventTitle(name, venueName) {
  let t = stripDiacritics(String(name ?? "")).toLowerCase().trim();

  // Trailing "this is actually the venue/qualifier" patterns, in order.
  t = t.replace(/\s*\/\/\s*.+$/, ""); // " // Edinburgh Queens Hall"
  t = t.replace(/\s*@\s*.+$/, ""); // " @ Queen's Hall"
  t = t.replace(/\s*\|\s*.+$/, ""); // " | ..."
  t = t.replace(/\s*\(edinburgh\)\s*$/, ""); // " (Edinburgh)"
  t = t.replace(/\s*[-–—]\s*edinburgh\s*$/, ""); // " - Edinburgh"

  if (venueName) {
    const v = stripDiacritics(String(venueName)).toLowerCase().trim();
    if (v) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      t = t.replace(new RegExp(`\\s+at\\s+(the\\s+)?${escaped}\\s*$`), ""); // " at (the) Queen's Hall"
      t = t.replace(new RegExp(`\\s*[-–—]\\s*${escaped}\\s*$`), ""); // " - Queen's Hall"
    }
  }
  // Generic " at <venue>" trailing suffix when it wasn't already caught by
  // the row's own venue name above (e.g. venue_name missing/different casing).
  t = t.replace(/\s+at\s+the\s+\S.*$/, "");

  t = t
    .replace(/['’]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return t;
}

// "the", "at" and Edinburgh/UK boilerplate that different sources pad venue
// names with inconsistently ("The Queen's Hall" vs "Queen's Hall, Edinburgh")
// and which would otherwise make an identical venue fail to key-match.
const VENUE_STOPWORDS = new Set(["the", "edinburgh", "uk", "scotland"]);

/**
 * Coarse venue identity for the cross-source key: same normalization as
 * normalizeEventTitle (diacritics/case/punctuation folded), minus stopwords,
 * so "The Queen's Hall" and "Queen's Hall, Edinburgh" match while "Edinburgh
 * Playhouse" and "Sheffield City Hall" (a touring show's two different
 * stops, same title, same/adjacent date) do not. Without this, a
 * title+date-only key would wrongly collapse distinct performances of a
 * touring production — different cities, or same city's matinee + evening
 * show on one date — onto a single row, silently dropping the other.
 */
function normalizeVenueKey(venueName) {
  const folded = stripDiacritics(String(venueName ?? ""))
    .toLowerCase()
    .replace(/['’]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!folded) return "?"; // no venue info at all — never claim a false match on emptiness
  return folded
    .split(" ")
    .filter((w) => w && !VENUE_STOPWORDS.has(w))
    .join(" ");
}

/**
 * Identity key: normalized title + Europe/London calendar date + coarse
 * (3h) time bucket + coarse venue. Venue (rather than lat/lng) survives
 * slightly different geocoding between sources for the very same venue,
 * and the time bucket tells apart a same-day matinee vs evening show at
 * that same venue; either alone (title+date, or title+date+venue) would
 * incorrectly merge distinct performances of a touring production —
 * different cities on the same date, or the same city's two showtimes.
 */
function crossSourceKey(row) {
  return `${normalizeEventTitle(row.name, row.venue_name)}|${londonDateKey(row.starts_at)}|${londonHourBucket(row.starts_at)}|${normalizeVenueKey(row.venue_name)}`;
}

// Preference order when two rows collapse onto the same key: the primary
// ticket sellers (Ticketmaster/Skiddle — official APIs) and Songkick (gig
// aggregator with its own canonical listing) outrank general discovery
// scrapes, which outrank allevents.in (already flagged elsewhere in this
// file as the noisiest/least precise source).
const PROVIDER_PRIORITY = { ticketmaster: 3, skiddle: 3, songkick: 2, luma: 1, eventbrite: 1, allevents: 0 };

/** True if `candidate` should replace `existing` for the same cross-source key. */
function isBetterRow(candidate, existing) {
  const cPrice = candidate.price_from != null;
  const ePrice = existing.price_from != null;
  if (cPrice !== ePrice) return cPrice;

  const cImage = candidate.image_url != null;
  const eImage = existing.image_url != null;
  if (cImage !== eImage) return cImage;

  const cUrl = candidate.ticket_url != null;
  const eUrl = existing.ticket_url != null;
  const cPri = PROVIDER_PRIORITY[candidate.provider] ?? 0;
  const ePri = PROVIDER_PRIORITY[existing.provider] ?? 0;
  if (cPri !== ePri) return cPri > ePri;
  if (cUrl !== eUrl) return cUrl;

  return false; // keep whichever was seen first
}

/** Cross-source dedupe. Returns the deduped rows plus a log of every collapse (kept vs dropped) for reporting. */
function dedupeAcrossSources(rows) {
  const best = new Map();
  const collapses = [];
  for (const row of rows) {
    const key = crossSourceKey(row);
    const existing = best.get(key);
    if (!existing) {
      best.set(key, row);
      continue;
    }
    if (isBetterRow(row, existing)) {
      collapses.push({ key, kept: row, dropped: existing });
      best.set(key, row);
    } else {
      collapses.push({ key, kept: existing, dropped: row });
    }
  }
  return { rows: Array.from(best.values()), collapses };
}

async function upsertEvents(rows) {
  if (rows.length === 0) return { ok: 0, failed: 0 };
  // Same clobber guard as lib/events/getForDestination.ts: image_url must be
  // *omitted* (not null) on rows with no photo, so a re-discovered event's
  // existing image survives an upsert untouched (supabase-js/PostgREST both
  // write every key present in the row object on conflict).
  const withPhoto = rows.filter((r) => r.image_url != null);
  const withoutPhoto = rows.filter((r) => r.image_url == null).map(({ image_url: _image_url, ...rest }) => rest);

  let ok = 0;
  let failed = 0;
  for (const [label, batch] of [["with-photo", withPhoto], ["without-photo", withoutPhoto]]) {
    if (batch.length === 0) continue;
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/events?on_conflict=provider,provider_event_id`, {
        method: "POST",
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${res.status}: ${body}`);
      }
      ok += batch.length;
      console.log(`[daily-sources] upserted ${batch.length} row(s) (${label})`);
    } catch (err) {
      failed += batch.length;
      console.error(`[daily-sources] upsert FAILED (${label}, ${batch.length} row(s)): ${err.message}`);
    }
  }
  return { ok, failed };
}

function printSummary(provider, stats, rows) {
  const s = stats;
  console.log(
    `[${provider}] fetched=${s.fetched} parsed=${s.parsed} kept=${rows.length} ` +
      `skipped(past=${s.skipped.past} invalid=${s.skipped.invalid} notEdinburgh=${s.skipped.notEdinburgh} robots=${s.skipped.robots} blocked=${s.skipped.blocked} offWedge=${s.skipped.offWedge})`
  );
  const samples = rows.slice(0, 3);
  for (const row of samples) {
    console.log(
      `    sample: "${row.name}" @ ${row.starts_at} | venue=${row.venue_name ?? "?"} | ` +
        `free=${row.is_free ?? "?"} price=${row.price_from ?? "?"} ${row.currency ?? ""} | id=${row.provider_event_id}`
    );
  }
}

async function main() {
  const now = new Date();
  const names = Object.keys(ADAPTERS).filter((n) => (!ONLY || ONLY.has(n)) && !SKIP.has(n));
  if (names.length === 0) {
    console.error(`[daily-sources] no adapters selected (--only/--skip/DAILY_SOURCES_SKIP left nothing to run; available: ${Object.keys(ADAPTERS).join(", ")})`);
    process.exit(1);
  }
  if (SKIP.size > 0) {
    console.log(`[daily-sources] skipping: ${[...SKIP].join(",")}`);
  }

  console.log(`[daily-sources] mode=${DRY_RUN ? "DRY RUN (pass --write to upsert)" : "WRITE"} sources=${names.join(",")}`);

  const perSource = [];
  for (const name of names) {
    console.log(`\n=== ${name} ===`);
    try {
      const result = await ADAPTERS[name](now);
      printSummary(result.provider, result.stats, result.rows);
      perSource.push(result);
    } catch (err) {
      console.error(`[${name}] adapter FAILED entirely: ${err.message}`);
      perSource.push({ provider: name, rows: [], stats: { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0, offWedge: 0 } } });
    }
  }

  const allRows = perSource.flatMap((s) => s.rows);
  const { rows: merged, collapses } = dedupeAcrossSources(allRows);
  const totalKept = perSource.reduce((sum, s) => sum + s.rows.length, 0);

  console.log(
    `\n[daily-sources] TOTAL kept-per-source=${totalKept} after cross-source dedupe=${merged.length} ` +
      `(${totalKept - merged.length} collapsed as likely duplicates across sources)`
  );
  if (collapses.length > 0) {
    console.log(`[daily-sources] cross-source collapses (kept <- dropped):`);
    for (const c of collapses) {
      console.log(
        `    "${c.kept.name}" (${c.kept.provider}) <- "${c.dropped.name}" (${c.dropped.provider}) | key="${c.key}"`
      );
    }
  }

  const beforeStr = Object.entries(CATEGORY_STATS.before).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");
  const afterStr = Object.entries(CATEGORY_STATS.after).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`\n[daily-sources] category distribution BEFORE keyword classifier: ${beforeStr || "(none)"}`);
  console.log(`[daily-sources] category distribution AFTER keyword classifier:  ${afterStr || "(none)"}`);

  if (DRY_RUN) {
    console.log("[daily-sources] DRY RUN — pass --write to actually upsert. Nothing written.");
    return;
  }

  const { ok, failed } = await upsertEvents(merged);
  console.log(`[daily-sources] write done: succeeded=${ok} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[daily-sources] fatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
