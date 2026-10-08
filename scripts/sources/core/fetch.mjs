/**
 * Polite fetching for the HTML/RSS-scraped sources: robots.txt (cached once
 * per host per run, fail-closed), per-host rate limiting, a 20s timeout and
 * bot-challenge detection. See the POLITENESS note in scripts/daily-sources.mjs.
 */

// A real, identifying UA — no personal contact info, just a project handle,
// per the "polite" brief. No secrets or user PII belong in an outbound
// request header.
export const USER_AGENT =
  "FomoEdinburghBot/1.0 (+https://github.com/jasbir98/fomo; daily events ingest)";
// The "product token" robots.txt directives are matched against — the first
// word of USER_AGENT, lowercased, no version/comment.
export const BOT_TOKEN = "fomoedinburghbot";

export const REQUEST_TIMEOUT_MS = 20_000;
export const PER_HOST_INTERVAL_MS = 1000; // ~1 req/sec per hostname, floor (Crawl-delay can raise it per host)

// Bot-challenge/interstitial markers — same reasoning and (mostly) same list
// as scraper/weekly_edinburgh.py's CHALLENGE_MARKERS: named vendor phrasing
// only, deliberately excludes bare "captcha"/"cloudflare" (too many false
// positives on ordinary pages that merely embed a vendor script).
export const CHALLENGE_MARKERS = [
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

export function looksLikeChallengePage(html) {
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

export function parseRobotsTxt(text) {
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
export function selectRobotsGroup(groups, botToken) {
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
export function robotsPatternToRegex(pattern) {
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
export function isAllowedByGroup(group, pathAndQuery) {
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
export async function getRobots(url) {
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
export async function waitForHostSlot(host, intervalMs) {
  const last = lastRequestAtByHost.get(host) ?? 0;
  const wait = intervalMs - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastRequestAtByHost.set(host, Date.now());
}

export async function politeFetch(url) {
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
