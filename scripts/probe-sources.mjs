#!/usr/bin/env node
/**
 * Manual probe: re-checks event/deal sites from the pipeline's real network
 * (GitHub Actions runners). Read-only, one request per target page plus one
 * robots.txt per host.
 *
 * Hard rules (this script must never try to get past a block):
 *   - One honest, identifying bot User-Agent. No browser UA, no spoofing.
 *   - No retries at all. A 403/429/challenge is recorded as-is and we move on.
 *   - robots.txt is fetched and obeyed. Disallowed targets are not fetched.
 *   - 1.5 s gap between requests to the same host. 20 s timeout per request.
 *
 * Usage:
 *   node scripts/probe-sources.mjs                     # all targets
 *   node scripts/probe-sources.mjs --only=fatsoma,5pm  # subset by id
 *
 * Output: Markdown table on stdout, appended to $GITHUB_STEP_SUMMARY if set,
 * and JSON written to scraper/out/probe-<YYYY-MM-DD>.json.
 */

import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Same identifying UA as scripts/daily-sources.mjs (the brief's string differed;
// reusing the one the pipeline already sends and is registered against).
const USER_AGENT =
  "FomoEdinburghBot/1.0 (+https://github.com/jasbir98/fomo; daily events ingest)";
// Product token robots.txt groups are matched against (first word of UA, lowercased).
const BOT_TOKEN = "fomoedinburghbot";

const REQUEST_TIMEOUT_MS = 20_000;
const PER_HOST_GAP_MS = 1500;

const CHALLENGE_MARKERS = [
  "Just a moment",
  "cf-chl",
  "Attention Required",
  "datadome",
  "Incapsula",
  "Access Denied",
  "Security Checkpoint",
];

const TARGETS = [
  { id: "5pm", kind: "event", url: "https://www.5pm.co.uk/" },
  { id: "ents24", kind: "event", url: "https://www.ents24.com/edinburgh-events" },
  { id: "nms", kind: "event", url: "https://www.nms.ac.uk/whats-on" },
  { id: "natgalleries", kind: "event", url: "https://www.nationalgalleries.org/exhibitions-events" },
  { id: "edinburgh-reporter", kind: "event", url: "https://theedinburghreporter.co.uk/" },
  { id: "stramash", kind: "event", url: "https://www.stramashedinburgh.com/" },
  { id: "whistlebinkies", kind: "event", url: "https://www.whistlebinkies.com/" },
  { id: "groupon", kind: "deal", url: "https://www.groupon.co.uk/local/edinburgh" },
  { id: "wowcher", kind: "deal", url: "https://www.wowcher.co.uk/deals/edinburgh" },
  { id: "thefork", kind: "deal", url: "https://www.thefork.co.uk/" },
  { id: "cineworld", kind: "deal", url: "https://www.cineworld.co.uk/" },
  { id: "odeon", kind: "deal", url: "https://www.odeon.co.uk/" },
  { id: "vue", kind: "deal", url: "https://www.myvue.com/" },
  { id: "tesco-clubcard", kind: "deal", url: "https://www.tesco.com/clubcard/" },
  { id: "o2-priority", kind: "deal", url: "https://priority.o2.co.uk/" },
  { id: "nandos", kind: "deal", url: "https://www.nandos.co.uk/" },
  { id: "opentable", kind: "deal", url: "https://www.opentable.co.uk/" },
  { id: "totum", kind: "deal", url: "https://www.totum.com/discounts" },
  { id: "fatsoma", kind: "event", url: "https://www.fatsoma.com/" },
  { id: "eatoutedinburgh", kind: "deal", url: "https://www.eatoutedinburgh.com/" },
  { id: "secret-edinburgh", kind: "event", url: "https://secretedinburgh.com/" },
  { id: "summerhall", kind: "event", url: "https://www.summerhall.co.uk/" },
  { id: "fixr", kind: "event", url: "https://fixr.co/" },
];

// --- args ---

function parseArgs(argv) {
  const args = { only: null };
  for (const a of argv) {
    if (a.startsWith("--only=")) {
      args.only = new Set(a.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean));
    }
  }
  return args;
}

// --- robots.txt (group selection + longest-match Allow/Disallow) ---

/** Parses robots.txt into groups: [{ agents: string[] (lowercased), rules: [{type:'allow'|'disallow', path}] }]. */
function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      // An empty Disallow means "allow everything" — record it so it can still match, but it never blocks.
      current.rules.push({ type: field, path: value });
    }
  }
  return groups;
}

/** Picks the group for our token if one names it, else the `*` group, else null. */
function selectGroup(groups) {
  const named = groups.filter((g) => g.agents.some((a) => a !== "*" && BOT_TOKEN.includes(a)));
  if (named.length) return named.flatMap((g) => g.rules);
  const star = groups.filter((g) => g.agents.includes("*"));
  if (star.length) return star.flatMap((g) => g.rules);
  return null;
}

/** Converts a robots path pattern (with * and $) to a RegExp anchored at the start. */
function patternToRegExp(pattern) {
  let src = "^";
  for (const ch of pattern) {
    if (ch === "*") src += ".*";
    else if (ch === "$") src += "$";
    else src += ch.replace(/[.+?^{}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(src);
}

/** Longest matching rule wins; on a tie, Allow wins (RFC 9309). No match means allowed. */
function isAllowed(rules, pathAndQuery) {
  if (!rules) return true;
  let best = null;
  for (const rule of rules) {
    if (rule.path === "") continue; // empty Disallow / Allow carries no pattern
    if (!patternToRegExp(rule.path).test(pathAndQuery)) continue;
    const len = rule.path.length;
    if (!best || len > best.len || (len === best.len && rule.type === "allow")) {
      best = { len, type: rule.type };
    }
  }
  return !best || best.type === "allow";
}

// --- fetching ---

const lastRequestAt = new Map();

async function paceHost(host) {
  const last = lastRequestAt.get(host) ?? 0;
  const wait = PER_HOST_GAP_MS - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt.set(host, Date.now());
}

/** Single GET with timeout. No retries, by design. */
async function getOnce(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await res.text();
    return { res, body };
  } finally {
    clearTimeout(timer);
  }
}

async function checkRobots(origin, pathAndQuery) {
  const host = new URL(origin).hostname;
  await paceHost(host);
  try {
    const { res, body } = await getOnce(`${origin}/robots.txt`, "text/plain,*/*");
    if (res.status === 404) return { status: 404, allowed: true, failClosed: false, error: false, note: "no robots.txt" };
    // Non-404 HTTP errors: fail closed for this host (we cannot confirm permission).
    if (!res.ok) return { status: res.status, allowed: false, failClosed: true, error: false, note: `robots HTTP ${res.status} (fail closed)` };
    const rules = selectGroup(parseRobots(body));
    return { status: res.status, allowed: isAllowed(rules, pathAndQuery), failClosed: false, error: false, note: "" };
  } catch (err) {
    return {
      status: null,
      allowed: false,
      failClosed: true,
      error: true,
      note: `robots error: ${err.name === "AbortError" ? "timeout" : err.message} (fail closed)`,
    };
  }
}

function countJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  let event = 0;
  let offer = 0;
  for (const b of blocks) {
    if (/"Event"/.test(b)) event++;
    if (/"Offer"/.test(b)) offer++;
  }
  return { ldJsonBlocks: blocks.length, ldJsonEvent: event, ldJsonOffer: offer };
}

function feedLinks(html) {
  const out = [];
  for (const m of html.matchAll(/<link[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']alternate["']/i.test(tag)) continue;
    if (!/type=["'](application\/rss\+xml|text\/calendar)["']/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i);
    if (href) out.push(href[1]);
  }
  return out;
}

function verdictFor({ robotsAllowed, status, challenge, error }) {
  if (error) return "ERROR";
  if (!robotsAllowed) return "ROBOTS_DISALLOWED";
  if (challenge) return "CHALLENGE";
  if (status >= 200 && status < 300) return "OPEN";
  return `BLOCKED_${status}`;
}

async function probeTarget(target) {
  const u = new URL(target.url);
  const pathAndQuery = u.pathname + u.search;
  const base = { id: target.id, kind: target.kind, url: target.url, origin: u.origin };

  const robots = await checkRobots(u.origin, pathAndQuery);
  if (!robots.allowed) {
    let verdict;
    if (robots.error) verdict = "ERROR";
    else if (robots.failClosed) verdict = `BLOCKED_${robots.status}`;
    else verdict = "ROBOTS_DISALLOWED";
    return { ...base, robotsStatus: robots.status, robotsAllowed: false, note: robots.note, verdict };
  }

  await paceHost(u.hostname);
  try {
    const { res, body } = await getOnce(target.url, "text/html,application/xhtml+xml");
    const challenge = CHALLENGE_MARKERS.find((m) => body.includes(m)) ?? null;
    const status = res.status;
    const result = {
      ...base,
      robotsStatus: robots.status,
      robotsAllowed: true,
      note: robots.note,
      status,
      finalUrl: res.url,
      server: res.headers.get("server"),
      cfMitigated: res.headers.get("cf-mitigated"),
      challengeMarker: challenge,
      bodyBytes: Buffer.byteLength(body, "utf8"),
      ...countJsonLd(body),
      hasNextData: /id=["']__NEXT_DATA__["']/.test(body),
      feedLinks: feedLinks(body),
    };
    result.verdict = verdictFor({ robotsAllowed: true, status, challenge: !!challenge || res.headers.get("cf-mitigated") === "challenge" });
    return result;
  } catch (err) {
    return {
      ...base,
      robotsStatus: robots.status,
      robotsAllowed: true,
      note: err.name === "AbortError" ? "timeout" : err.message,
      error: true,
      verdict: verdictFor({ robotsAllowed: true, error: true }),
    };
  }
}

// --- output ---

function toMarkdown(rows) {
  const header = "| id | kind | verdict | status | final URL | server | cf-mitigated | challenge marker | body bytes | ld+json (Event/Offer) | __NEXT_DATA__ | feeds | robots | note |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const lines = rows.map((r) =>
    [
      r.id,
      r.kind,
      r.verdict,
      r.status ?? "-",
      r.finalUrl ?? "-",
      r.server ?? "-",
      r.cfMitigated ?? "-",
      r.challengeMarker ?? "-",
      r.bodyBytes ?? "-",
      r.ldJsonBlocks != null ? `${r.ldJsonBlocks} (${r.ldJsonEvent}/${r.ldJsonOffer})` : "-",
      r.hasNextData ? "yes" : "no",
      r.feedLinks?.length ? r.feedLinks.join(", ") : "-",
      r.robotsStatus ?? "-",
      r.note || "-",
    ]
      .map((c) => String(c).replace(/\|/g, "\\|").replace(/\n/g, " "))
      .join(" | ")
  );
  return [header, sep, ...lines.map((l) => `| ${l} |`)].join("\n");
}

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const { only } = parseArgs(process.argv.slice(2));
  const targets = only ? TARGETS.filter((t) => only.has(t.id)) : TARGETS;
  const unknown = only ? [...only].filter((id) => !TARGETS.some((t) => t.id === id)) : [];
  if (unknown.length) console.error(`[probe] unknown ids ignored: ${unknown.join(", ")}`);
  if (!targets.length) {
    console.error("[probe] no targets selected");
    process.exit(1);
  }

  const rows = [];
  for (const t of targets) {
    console.error(`[probe] ${t.id} ${t.url}`);
    rows.push(await probeTarget(t));
  }

  const date = isoDate();
  const md = `## Source probe ${date}\n\n${toMarkdown(rows)}\n`;
  process.stdout.write(md);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "..", "scraper", "out");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `probe-${date}.json`);
  await writeFile(outPath, JSON.stringify({ date, userAgent: USER_AGENT, results: rows }, null, 2) + "\n");
  console.error(`[probe] wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
