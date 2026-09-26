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
 * PostgREST) and upserts normalized rows into `events`, keyed on
 * (provider, provider_event_id) — the same unique index Skiddle/Ticketmaster
 * already use, so a row already cached by a live user request and a row
 * found here for the same event just co-exist as two different provider
 * rows (cross-provider dedupe at read time already exists —
 * lib/happenings/merge-events.ts's `dedupeProviderEvents`).
 *
 * SOURCES (all free, public, no auth):
 *   luma       https://lu.ma/edinburgh                                    (~20 events; tech/startup/networking)
 *   eventbrite https://www.eventbrite.co.uk/d/united-kingdom--edinburgh/...  (discover pages, 20/page)
 *   songkick   https://www.songkick.com/metro-areas/24551-uk-edinburgh    (gigs; NOT 24542, that's Birmingham)
 *   allevents  https://allevents.in/edinburgh/all                         (leaks non-Edinburgh rows — geo-filtered below)
 *
 * POLITENESS. robots.txt is fetched and evaluated once per hostname per run
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
 */

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node --env-file=.env.local scripts/daily-sources.mjs [options]

Crawls lu.ma, Eventbrite, Songkick and allevents.in's Edinburgh listing
pages for schema.org Event JSON-LD and upserts normalized rows into
\`events\`, deduped on (provider, provider_event_id).

Options:
  --dry-run       Print per-source counts + 3 sample rows, write nothing.
                   Default behavior when neither --dry-run nor --write is given.
  --write         Actually upsert into \`events\`.
  --only=a,b      Only run the named adapters (luma, eventbrite, songkick, allevents).

Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the env to --write.
`);
  process.exit(0);
}

const WRITE = process.argv.includes("--write");
const DRY_RUN = !WRITE;

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim())) : null;

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

/**
 * Fetch a page and extract normalized rows from its JSON-LD Event objects.
 * Returns per-page stats plus the rows. Never throws.
 */
async function fetchAndExtract(url, { provider, destination, now, requireEdinburgh }) {
  const stats = { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0 } };
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

// --- adapters ----------------------------------------------------------------

async function adapterLuma(now) {
  const provider = "luma";
  const pages = ["https://lu.ma/edinburgh"];
  let stats = { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0 } };
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
  let stats = { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0 } };
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
  let stats = { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0 } };
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
  let stats = { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0 } };
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

const ADAPTERS = {
  luma: adapterLuma,
  eventbrite: adapterEventbrite,
  songkick: adapterSongkick,
  allevents: adapterAllevents,
};

// --- cross-source merge + upsert ----------------------------------------------

/** Same identity heuristic as lib/events/dedupe.ts: slugified name + calendar day + coarse lat/lng. */
function crossSourceKey(row) {
  const day = row.starts_at.slice(0, 10);
  const lat = row.lat != null ? row.lat.toFixed(3) : "?";
  const lng = row.lng != null ? row.lng.toFixed(3) : "?";
  return `${slugify(row.name)}|${day}|${lat},${lng}`;
}

function dedupeAcrossSources(rows) {
  const best = new Map();
  for (const row of rows) {
    const key = crossSourceKey(row);
    const existing = best.get(key);
    if (!existing) {
      best.set(key, row);
      continue;
    }
    // Prefer whichever candidate has an image; otherwise keep the first seen.
    if (row.image_url != null && existing.image_url == null) best.set(key, row);
  }
  return Array.from(best.values());
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
      `skipped(past=${s.skipped.past} invalid=${s.skipped.invalid} notEdinburgh=${s.skipped.notEdinburgh} robots=${s.skipped.robots} blocked=${s.skipped.blocked})`
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
  const names = Object.keys(ADAPTERS).filter((n) => !ONLY || ONLY.has(n));
  if (names.length === 0) {
    console.error(`[daily-sources] --only matched no adapters (available: ${Object.keys(ADAPTERS).join(", ")})`);
    process.exit(1);
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
      perSource.push({ provider: name, rows: [], stats: { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0 } } });
    }
  }

  const allRows = perSource.flatMap((s) => s.rows);
  const merged = dedupeAcrossSources(allRows);
  const totalKept = perSource.reduce((sum, s) => sum + s.rows.length, 0);

  console.log(
    `\n[daily-sources] TOTAL kept-per-source=${totalKept} after cross-source dedupe=${merged.length} ` +
      `(${totalKept - merged.length} collapsed as likely duplicates across sources)`
  );

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
