/**
 * Pure helpers for scripts/check-event-sample.mjs: does an event's own page
 * mention its title words and its (Europe/London) date?
 */

import { decodeHtmlEntities } from "./describe.mjs";
import { normalizeEventTitle, stripDiacritics } from "../sources/core/dedupe.mjs";
import { londonDateKey } from "../sources/core/time.mjs";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const TITLE_STOPWORDS = new Set(["the", "and", "with", "for", "live", "presents", "present", "from", "tour", "in", "of", "at", "on", "an", "a", "to", "is", "by", "us", "uk", "edinburgh"]);

/** Visible-ish text of an HTML page: scripts/styles dropped, tags stripped, title/og/meta text kept, entities decoded, diacritics folded, lowercased. */
export function pageText(html) {
  const meta = [];
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) meta.push(titleMatch[1]);
  for (const m of html.matchAll(/<meta\s+[^>]*?(?:property|name)=["'](?:og:title|og:description|description|twitter:title)["'][^>]*?content=["']([^"']*)["'][^>]*>/gi)) meta.push(m[1]);
  for (const m of html.matchAll(/<meta\s+[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["'](?:og:title|og:description|description|twitter:title)["'][^>]*>/gi)) meta.push(m[1]);
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return stripDiacritics(decodeHtmlEntities(`${meta.join(" ")} ${body}`))
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Significant lowercase tokens of a title (reuses the cross-source title normalisation). */
export function significantTokens(name, venueName) {
  const tokens = normalizeEventTitle(name, venueName).split(" ").filter(Boolean);
  const significant = tokens.filter((t) => t.length >= 3 && !TITLE_STOPWORDS.has(t));
  return significant.length > 0 ? significant : tokens;
}

/** Fraction (0-1) of significant title tokens found as whole words in `text`. */
export function titleTokenCoverage(name, venueName, text) {
  const tokens = significantTokens(name, venueName);
  if (tokens.length === 0) return 0;
  const found = tokens.filter((t) => new RegExp(`(?<![a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(text));
  return found.length / tokens.length;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** True when `text` (lowercased page text) or `rawHtml` (lowercased) mentions the Y-M-D date in a common format. */
export function pageHasDate(text, ymd, rawHtml = "") {
  const [y, m, d] = ymd.split("-").map(Number);
  const month = MONTHS[m - 1];
  const short = month.slice(0, 3);
  const monthAlts = [...new Set([month, short, month === "september" ? "sept" : short])].join("|");
  const day = String(d);
  const dayAlts = d < 10 ? `0?${day}` : day;
  const ord = "(?:st|nd|rd|th)?";
  const dd = String(d).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const patterns = [
    new RegExp(`(?<!\\d)${dayAlts}${ord}\\s+(?:of\\s+)?(?:${monthAlts})\\b`), // 9 October, 9th of Oct, 09 oct
    new RegExp(`\\b(?:${monthAlts})\\.?\\s+${dayAlts}${ord}(?!\\d)`), // October 9, Oct 9th
    new RegExp(`(?<!\\d)${dayAlts}[/.\\-]0?${m}[/.\\-](?:${y}|${String(y).slice(2)})(?!\\d)`), // 09/10/2026, 9.10.26
  ];
  if (patterns.some((re) => re.test(text))) return true;
  // Listing posts with day headers and no month on each ("SUNDAY 11th"): accept
  // the right weekday + day, but only when the page names the month somewhere.
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  if (new RegExp(`\\b${weekday}\\s+${dayAlts}${ord}(?!\\d)`).test(text) && new RegExp(`\\b(?:${monthAlts})\\b`).test(text)) return true;
  const iso = `${y}-${mm}-${dd}`;
  if (text.includes(iso) || rawHtml.includes(iso)) return true;
  return false;
}

/** Check one row against fetched HTML. Returns { titlePct, dateFound, pass }. */
export function checkRowAgainstHtml(row, html, { minTitlePct = 0.6 } = {}) {
  const text = pageText(html);
  const titlePct = titleTokenCoverage(row.name, row.venue_name, text);
  const ymd = londonDateKey(row.starts_at);
  const dateFound = pageHasDate(text, ymd, html.toLowerCase());
  return { titlePct, dateFound, ymd, pass: titlePct >= minTitlePct && dateFound };
}
