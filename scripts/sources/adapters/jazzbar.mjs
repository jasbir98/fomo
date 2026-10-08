/**
 * jazzbar adapter — The Jazz Bar, 1A Chambers Street, Edinburgh (thejazzbar.co.uk).
 *
 * Gigs are published as fortnightly WordPress posts ("1st-15th October 2026 - Full Live Music Listings").
 * The post HTML is hand-edited and noisy (nested Eventbrite/Google-Docs wrapper divs, mixed h2/h3/h4), but
 * once converted to lines it is regular:
 *
 *   *** FRIDAY 2nd ***                         <- day header (month from the latest "October" heading)
 *   <h2|h3> Colin Steele Trio                  <- gig title (a heading line)
 *   18:15 - 20:30, GBP12 ADV or on the door    <- time line: start[-end], then price words
 *   free-text description ...
 *
 * So the PRIMARY path is a deterministic parser (no LLM, no cost). A DeepSeek extraction
 * (core/deepseek.mjs, forced tool call, <= $0.10/run) is only the FALLBACK when the parse looks
 * unreliable (see parseIsReliable) AND DEEPSEEK_API_KEY is set.
 *
 * EVIDENCE GATE (both paths, reused from scripts/lib/extraction-gate.mjs): the gig's quote (deterministic
 * path: title + time line) must appear verbatim in the normalised post text; its date must equal the
 * day header the quote sits under (also a weekday/date consistency check when the header is resolved);
 * the stated time must be in the quote; every GBP figure in price_text must be in the quote. Rejects
 * are counted by reason (stats are returned on the adapter result as `rejects`).
 *
 * Times 00:00-05:59 belong to the previous day's header (late-night sets): starts_at is the real
 * instant (the next calendar day), provider_event_id keeps the header date.
 */

import { cleanDescription, decodeHtmlEntities } from "../../lib/describe.mjs";
import { moneyFigures, normalise, MAX_QUOTE_LEN } from "../../lib/extraction-gate.mjs";
import { DESTINATION, LOOKAHEAD_DAYS } from "../core/config.mjs";
import { callTool, createBudget, DEFAULT_MAX_SPEND_USD } from "../core/deepseek.mjs";
import { politeJson } from "../core/json-fetch.mjs";
import { canonicalUrl } from "../core/jsonld.mjs";
import { dedupeWithinSource } from "../core/normalize.mjs";
import { fetchProviderRows, hashText, isUnchanged, loadLedger, recordPages, reemitRow } from "../core/page-ledger.mjs";
import { emptyStats } from "../core/stats.mjs";
import { londonDateKey } from "../core/time.mjs";
import { addDays, londonWallToIso } from "../core/wall-time.mjs";

export const PROVIDER = "jazzbar";
export const POSTS_URL = "https://www.thejazzbar.co.uk/wp-json/wp/v2/posts?search=listings&per_page=5&orderby=date&_fields=id,date,modified,link,title,content";
export const MAX_POSTS = 2;

// Verified on https://www.thejazzbar.co.uk/contact-us/ ("1a Chambers Street ... EH1 1HR"). The site publishes
// no coordinates; lat/lng are the OpenStreetMap node for The Jazz Bar (osm.org node 5869015354).
export const VENUE = {
  venue_name: "The Jazz Bar",
  address: "1A Chambers Street, Edinburgh EH1 1HR",
  city: "Edinburgh",
  lat: 55.9481208,
  lng: -3.1869531,
};

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAY_RE = DAYS.join("|");
const MONTH_RE = MONTHS.join("|");
const HEADER_RE = new RegExp(`^[\\s*]*(${DAY_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(${MONTH_RE}))?[\\s*]*$`, "i");
const MONTH_HEADING_RE = new RegExp(`^[\\s*]*(${MONTH_RE})(?:\\s+(\\d{4}))?[\\s*]*$`, "i");
const TIME_LINE_RE = /^(\d{1,2}):(\d{2})\b/;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

// --- HTML -> lines ------------------------------------------------------------

/** Post HTML -> [{ tag: "h2"|...|null, text, hrefs: [] }], blank lines dropped. */
export function htmlToLines(html) {
  const marked = String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*?href="([^"]*)"[^>]*>/gi, (_m, u) => `\u0001${u}\u0002`)
    .replace(/<\/a>/gi, "")
    .replace(/<(h[1-6])\b[^>]*>/gi, "\n\u0003$1\u0004")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  const lines = [];
  for (const raw of marked.split("\n")) {
    let s = raw;
    let tag = null;
    const t = s.match(/^\u0003(h[1-6])\u0004/);
    if (t) {
      tag = t[1].toLowerCase();
      s = s.slice(t[0].length);
    }
    const hrefs = [];
    s = s.replace(/\u0001([^\u0002]*)\u0002/g, (_m, u) => {
      hrefs.push(decodeHtmlEntities(u));
      return "";
    });
    const text = decodeHtmlEntities(s).replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push({ tag, text, hrefs });
  }
  return lines;
}

// --- dates ----------------------------------------------------------------------

/** Resolve (weekday, day, month index 0-11) to YYYY-MM-DD whose weekday matches, year nearest `anchorDate`. Null if none. */
export function resolveDate(weekday, day, monthIdx, anchorDate) {
  const anchor = new Date(`${anchorDate}T00:00:00Z`).getTime();
  const wd = DAYS.indexOf(weekday.toLowerCase());
  const ay = new Date(anchor).getUTCFullYear();
  let best = null;
  for (const y of [ay - 1, ay, ay + 1]) {
    const d = new Date(Date.UTC(y, monthIdx, day));
    if (d.getUTCMonth() !== monthIdx || d.getUTCDate() !== day || d.getUTCDay() !== wd) continue;
    const dist = Math.abs(d.getTime() - anchor);
    if (dist > 200 * 86_400_000) continue; // a listing is never published months away from its dates
    if (!best || dist < best.dist) best = { dist, iso: d.toISOString().slice(0, 10) };
  }
  return best ? best.iso : null;
}

// --- deterministic parse -----------------------------------------------------------

/**
 * Parse the post's lines. `anchorDate` (YYYY-MM-DD, the post's publish date) fixes month/year when a header
 * lacks them. Returns { headers, gigs, orphanHeadings, normText }.
 *  headers: [{ date, offset, lineIdx, weekday, ok }]    (ok=false when the weekday/date did not reconcile)
 *  gigs:    [{ title, date, time, endTime, price_text, quote, tickets, description, headerDate }]
 */
export function parseListings(lines, anchorDate) {
  const norm = lines.map((l) => normalise(l.text));
  const offsets = [];
  let acc = 0;
  for (const n of norm) {
    offsets.push(acc);
    acc += n.length + 1;
  }
  const normText = norm.join(" ");

  const headers = [];
  let ctxMonth = Number(anchorDate.slice(5, 7)) - 1;
  let prevDay = 0;
  let current = null;
  const gigs = [];
  const titleIdx = new Set();
  const blocks = []; // { gig, startIdx }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const hm = line.text.match(HEADER_RE);
    if (hm) {
      const day = Number(hm[2]);
      let monthIdx;
      if (hm[3]) {
        monthIdx = MONTHS.indexOf(hm[3].toLowerCase());
      } else {
        monthIdx = ctxMonth;
        if (day < prevDay) monthIdx = (monthIdx + 1) % 12; // list rolled into the next month without a month heading
      }
      let iso = resolveDate(hm[1], day, monthIdx, anchorDate);
      if (!iso && !hm[3]) {
        // header month context may be stale: try the next month
        const next = (monthIdx + 1) % 12;
        iso = resolveDate(hm[1], day, next, anchorDate);
        if (iso) monthIdx = next;
      }
      if (iso) {
        ctxMonth = monthIdx;
        prevDay = day;
      }
      current = { date: iso, offset: offsets[i], lineIdx: i, weekday: hm[1].toLowerCase(), ok: Boolean(iso) };
      headers.push(current);
      continue;
    }
    const mm = line.text.match(MONTH_HEADING_RE);
    if (mm && line.tag) {
      ctxMonth = MONTHS.indexOf(mm[1].toLowerCase());
      prevDay = 0;
      continue;
    }
    if (!current || !TIME_LINE_RE.test(line.text)) continue;

    const prev = i > 0 ? lines[i - 1] : null;
    const prevIsTitle = prev && prev.tag && !HEADER_RE.test(prev.text) && !MONTH_HEADING_RE.test(prev.text) && !TIME_LINE_RE.test(prev.text);
    if (!prevIsTitle) {
      gigs.push({ rejected: "no_title", headerDate: current.date, quote: line.text });
      continue;
    }
    const tm = line.text.match(/^(\d{1,2}):(\d{2})(?:\s*[–-]\s*(\d{1,2}):(\d{2}))?/);
    const pad = (h, m) => `${String(h).padStart(2, "0")}:${m}`;
    const time = pad(tm[1], tm[2]);
    const endTime = tm[3] ? pad(tm[3], tm[4]) : null;
    let rest = line.text.slice(tm[0].length).replace(/^\s*(start|doors(?: open)?|open rehearsal)?\s*[,–-]*\s*/i, "").trim();
    rest = rest.replace(/\bTickets? here!?/gi, "").replace(/\s+/g, " ").replace(/[\s,–-]+$/, "").trim();
    titleIdx.add(i - 1);
    gigs.push({
      title: prev.text,
      date: current.date,
      headerDate: current.date,
      time,
      endTime,
      price_text: rest || null,
      quote: `${prev.text} ${line.text}`,
      tickets: null,
      description: null,
      _titleIdx: i - 1,
      _timeIdx: i,
    });
  }

  // Attach ticket links + description: lines from the time line up to the next gig's title line.
  const real = gigs.filter((g) => g._titleIdx != null);
  for (let k = 0; k < real.length; k += 1) {
    const g = real[k];
    const end = k + 1 < real.length ? real[k + 1]._titleIdx : lines.length;
    // also stop at the next day header
    let stop = end;
    for (const h of headers) if (h.lineIdx > g._timeIdx && h.lineIdx < stop) stop = h.lineIdx;
    const block = lines.slice(g._titleIdx, stop);
    const hrefs = block.flatMap((l) => l.hrefs);
    const eb = hrefs.find((u) => /eventbrite\.[a-z.]+\/e\//i.test(u));
    g.tickets = eb ? canonicalUrl(eb) : null;
    const descLine = lines.slice(g._timeIdx + 1, stop).find((l) => !l.tag && !TIME_LINE_RE.test(l.text) && !/^(tickets? here|click here)/i.test(l.text) && l.text.length > 25);
    g.description = descLine ? descLine.text : null;
  }

  // Headings (h2/h3) inside the listing that did not become a gig title: parser blind spots.
  const lastHeader = headers.at(-1)?.lineIdx ?? -1;
  const firstHeader = headers[0]?.lineIdx ?? Infinity;
  const orphanHeadings = lines
    .map((l, i) => ({ l, i }))
    .filter(
      ({ l, i }) =>
        (l.tag === "h2" || l.tag === "h3") &&
        i > firstHeader &&
        i < lastHeader + 40 &&
        !titleIdx.has(i) &&
        !MONTH_HEADING_RE.test(l.text) &&
        !/subscribe to blog/i.test(l.text)
    ).length;

  return { headers, gigs, orphanHeadings, normText };
}

/** Reliable enough to skip the LLM? Needs a reasonable gig count, few blind-spot headings and no empty/unresolved days. */
export function parseIsReliable(parsed) {
  const good = parsed.gigs.filter((g) => !g.rejected);
  if (good.length < 3) return false;
  if (parsed.orphanHeadings / good.length > 0.1) return false;
  if (parsed.gigs.length > good.length && (parsed.gigs.length - good.length) / parsed.gigs.length > 0.1) return false;
  const badHeaders = parsed.headers.filter((h) => !h.ok).length;
  if (parsed.headers.length === 0 || badHeaders / parsed.headers.length > 0.1) return false;
  const daysWithGigs = new Set(good.map((g) => g.headerDate));
  const empty = parsed.headers.filter((h) => h.ok && !daysWithGigs.has(h.date)).length;
  return empty / parsed.headers.length <= 0.1;
}

// --- evidence gate ------------------------------------------------------------------

export const GATE_REASONS = ["no_title", "bad_header", "quote_not_found", "quote_too_long", "date_mismatch", "title_not_in_quote", "time_not_in_quote", "price_not_in_quote"];

/**
 * Gate one gig {title,date,time,price_text,quote}. G = { normText, headers }.
 * Returns { ok:true } | { ok:false, reason }.
 */
export function gateGig(gig, G) {
  if (gig.rejected) return { ok: false, reason: gig.rejected };
  if (!gig.title || !gig.date) return { ok: false, reason: gig.date ? "no_title" : "bad_header" };
  const quote = String(gig.quote ?? "").trim();
  const q = normalise(quote);
  if (!q) return { ok: false, reason: "quote_not_found" };
  if (quote.length > MAX_QUOTE_LEN) return { ok: false, reason: "quote_too_long" };

  // all occurrences of the quote in the post text
  const hits = [];
  for (let at = G.normText.indexOf(q); at !== -1; at = G.normText.indexOf(q, at + 1)) hits.push(at);
  if (hits.length === 0) return { ok: false, reason: "quote_not_found" };

  const governing = (at) => {
    let h = null;
    for (const hd of G.headers) if (hd.offset <= at) h = hd;
    return h;
  };
  if (!hits.some((at) => governing(at)?.ok && governing(at).date === gig.date)) return { ok: false, reason: "date_mismatch" };

  if (!q.includes(normalise(gig.title))) return { ok: false, reason: "title_not_in_quote" };
  if (gig.time && !q.includes(gig.time)) return { ok: false, reason: "time_not_in_quote" };
  if (gig.price_text) {
    const have = moneyFigures(quote);
    for (const fig of moneyFigures(gig.price_text)) if (!have.has(fig)) return { ok: false, reason: "price_not_in_quote" };
  }
  return { ok: true };
}

// --- row building ---------------------------------------------------------------------

function slug(s) {
  return String(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function displayTitle(t) {
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length > 3 && letters === letters.toUpperCase()) {
    return t.toLowerCase().replace(/(^|[\s('"-])([a-z])/g, (_m, p, c) => p + c.toUpperCase());
  }
  return t;
}

/** { isFree, priceFrom } from the time line's price words. "free to play" refers to musicians, not entry. */
export function parseGigPrice(priceText) {
  if (!priceText) return { isFree: null, priceFrom: null };
  const figs = [...priceText.matchAll(/£\s?(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?/g)].flatMap((m) => [m[1], m[2]].filter(Boolean).map(Number));
  if (figs.length > 0) {
    const min = Math.min(...figs);
    return { isFree: min === 0, priceFrom: min };
  }
  if (/\bfree\b/i.test(priceText.replace(/free to play/gi, ""))) return { isFree: true, priceFrom: 0 };
  return { isFree: null, priceFrom: null };
}

/** Gate-passed gig -> events row. */
export function buildGigRow(gig, { postLink, now }) {
  const startDate = gig.time && Number(gig.time.slice(0, 2)) < 6 ? addDays(gig.date, 1) : gig.date;
  const startsAt = gig.time ? londonWallToIso(startDate, gig.time) : `${gig.date}T00:00:00.000Z`;
  let endsAt = null;
  if (gig.time && gig.endTime) {
    const endDate = gig.endTime <= gig.time ? addDays(startDate, 1) : startDate;
    endsAt = londonWallToIso(endDate, gig.endTime);
  }
  const { isFree, priceFrom } = parseGigPrice(gig.price_text);
  const name = displayTitle(gig.title);
  return {
    provider: PROVIDER,
    provider_event_id: `${gig.date}-${(gig.time ?? "0000").replace(":", "")}-${slug(gig.title)}`,
    name,
    description: cleanDescription(gig.description, { title: name, venueName: VENUE.venue_name }),
    category: "music",
    image_url: null,
    ticket_url: gig.tickets ?? postLink,
    starts_at: startsAt,
    ends_at: endsAt,
    venue_name: VENUE.venue_name,
    address: VENUE.address,
    lat: VENUE.lat,
    lng: VENUE.lng,
    city: VENUE.city,
    country: "GB",
    is_free: isFree,
    price_from: priceFrom,
    currency: priceFrom != null && priceFrom > 0 ? "GBP" : null,
    destination: DESTINATION,
    source: "api",
    fetched_at: now.toISOString(),
  };
}

// --- LLM fallback ------------------------------------------------------------------------

const SUBMIT_TOOL = {
  name: "submit_gigs",
  description: "Submit every gig found in the listing text.",
  input_schema: {
    type: "object",
    properties: {
      gigs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Act / event title exactly as written" },
            date: { type: "string", description: "YYYY-MM-DD, copied from the DAY marker the gig sits under" },
            time: { type: ["string", "null"], description: "Start time HH:MM (24h) as written, or null" },
            price_text: { type: ["string", "null"], description: "Price words as written, or null" },
            quote: { type: "string", description: "Verbatim text from the listing containing the title and its time line (<= 400 chars)" },
          },
          required: ["title", "date", "time", "price_text", "quote"],
        },
      },
    },
    required: ["gigs"],
  },
};

/** Text for the model: lines, with each day header replaced by an unambiguous ISO DAY marker. */
function chunkForLlm(lines, headers, maxDaysPerChunk = 5) {
  const chunks = [];
  let cur = [];
  let days = 0;
  const byIdx = new Map(headers.map((h) => [h.lineIdx, h]));
  lines.forEach((l, i) => {
    const h = byIdx.get(i);
    if (h?.ok) {
      if (days >= maxDaysPerChunk) {
        chunks.push(cur.join("\n"));
        cur = [];
        days = 0;
      }
      days += 1;
      cur.push(`=== DAY ${h.date} ===`);
    } else if (days > 0) {
      cur.push(l.text);
    }
  });
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks;
}

export async function extractViaLlm(lines, parsed, budget, rejects) {
  const out = [];
  for (const text of chunkForLlm(lines, parsed.headers)) {
    const r = await callTool({
      system:
        "You extract gig listings from a venue's text. Output only gigs that are literally listed. Copy titles, times and prices exactly as written. " +
        "The date is the ISO date of the '=== DAY YYYY-MM-DD ===' marker the gig appears under. The quote must be copied verbatim from the text (title line and time/price line).",
      user: `Listing text:\n\n${text}`,
      tool: SUBMIT_TOOL,
      maxTokens: 8000,
      budget,
    });
    if (!r.ok) {
      rejects.llm_call_failed = (rejects.llm_call_failed ?? 0) + 1;
      console.log(`  [${PROVIDER}] LLM call failed: ${r.reason}`);
      if (r.reason === "budget_exhausted" || r.reason === "no_api_key") break;
      continue;
    }
    for (const g of r.input.gigs ?? []) {
      out.push({
        title: typeof g.title === "string" ? g.title.trim() : "",
        date: typeof g.date === "string" ? g.date : null,
        time: typeof g.time === "string" && /^\d{2}:\d{2}$/.test(g.time) ? g.time : null,
        endTime: null,
        price_text: typeof g.price_text === "string" && g.price_text.trim() ? g.price_text.trim() : null,
        quote: typeof g.quote === "string" ? g.quote : "",
        tickets: null,
        description: null,
      });
    }
  }
  return out;
}

// --- adapter --------------------------------------------------------------------------------

export function titleText(post) {
  return decodeHtmlEntities(post.title?.rendered ?? "");
}

export default {
  name: "jazzbar",
  cadence: "daily",
  status: "shadow",
  async run({ now, write = false }) {
    const stats = emptyStats();
    const rejects = {};
    const info = { posts: [], path: "deterministic", llmCalls: 0, llmCostUsd: 0, llmTokens: { in: 0, out: 0 } };
    const rows = [];

    const list = await politeJson(POSTS_URL);
    if (!list.ok || !Array.isArray(list.data)) {
      if (list.reason === "robots_disallowed" || list.reason === "robots_unavailable") stats.skipped.robots += 1;
      else stats.skipped.blocked += 1;
      console.log(`  [${PROVIDER}] post list -> SKIPPED (${list.reason})`);
      return { provider: PROVIDER, rows, stats, rejects };
    }
    stats.fetched += 1;

    const today = londonDateKey(now.toISOString());
    const windowEnd = addDays(today, LOOKAHEAD_DAYS);
    const posts = list.data
      .filter((p) => /listings/i.test(titleText(p)))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));

    const budget = createBudget(DEFAULT_MAX_SPEND_USD);
    const existing = await fetchProviderRows(PROVIDER, now);
    await loadLedger(PROVIDER);
    const ledgerEntries = [];
    let used = 0;

    for (const post of posts) {
      if (used >= MAX_POSTS) break;
      const html = post.content?.rendered ?? "";
      const lines = htmlToLines(html);
      const anchor = String(post.date).slice(0, 10);
      const parsed = parseListings(lines, anchor);
      const okDates = parsed.headers.filter((h) => h.ok).map((h) => h.date).sort();
      if (okDates.length === 0) continue;
      const first = okDates[0];
      const last = okDates.at(-1);
      if (last < today || first > windowEnd) continue; // does not overlap today..today+31
      used += 1;
      stats.parsed += 1;

      const G = { normText: parsed.normText, headers: parsed.headers };
      const hash = hashText(parsed.normText);
      ledgerEntries.push({ url: post.link, source_id: PROVIDER, content_hash: hash, status: 200 });
      let gigs;
      let path = "deterministic";
      if (parseIsReliable(parsed)) {
        gigs = parsed.gigs;
      } else if (!process.env.DEEPSEEK_API_KEY) {
        console.log(`  [${PROVIDER}] parse unreliable for ${post.link} and DEEPSEEK_API_KEY not set — using the parse as is`);
        gigs = parsed.gigs;
        path = "deterministic(unreliable)";
      } else {
        // Page unchanged since the last extraction and we already hold its rows: re-emit, no LLM.
        const prevRows = existing.filter((r) => r.starts_at >= `${first}T00:00:00Z` && r.starts_at <= `${addDays(last, 2)}T00:00:00Z`);
        if (isUnchanged(post.link, hash) && prevRows.length > 0) {
          for (const r of prevRows) rows.push(reemitRow(r, now));
          stats.kept += prevRows.length;
          path = "ledger-reemit";
          info.posts.push({ link: post.link, first, last, path, gigs: prevRows.length });
          continue;
        }
        gigs = await extractViaLlm(lines, parsed, budget, rejects);
        path = "llm";
      }
      if (path !== "deterministic") info.path = path;

      let kept = 0;
      for (const gig of gigs) {
        const verdict = gateGig(gig, G);
        if (!verdict.ok) {
          rejects[verdict.reason] = (rejects[verdict.reason] ?? 0) + 1;
          stats.skipped.invalid += 1;
          continue;
        }
        if (gig.date < today) {
          stats.skipped.past += 1;
          continue;
        }
        rows.push(buildGigRow(gig, { postLink: post.link, now }));
        kept += 1;
        stats.kept += 1;
      }
      info.posts.push({ link: post.link, first, last, path, gigs: kept, headers: parsed.headers.length, orphanHeadings: parsed.orphanHeadings });
    }

    info.llmCalls = budget.calls;
    info.llmCostUsd = Number(budget.spentUsd.toFixed(6));
    info.llmTokens = { in: budget.inputTokens, out: budget.outputTokens };
    await recordPages(ledgerEntries, { write, now });
    console.log(`  [${PROVIDER}] ${JSON.stringify(info)}`);
    console.log(`  [${PROVIDER}] gate rejects by reason: ${JSON.stringify(rejects)}`);
    return { provider: PROVIDER, rows: dedupeWithinSource(rows), stats, rejects, info };
  },
};
