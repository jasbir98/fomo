import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildGigRow, gateGig, htmlToLines, parseGigPrice, parseIsReliable, parseListings, resolveDate } from "./jazzbar.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const html = readFileSync(path.join(dir, "jazzbar-post-7021.html"), "utf8");
const lines = htmlToLines(html);
const parsed = parseListings(lines, "2026-09-30");
const G = { normText: parsed.normText, headers: parsed.headers };
const NOW = new Date("2026-10-08T10:00:00Z");
const byTitle = (t) => parsed.gigs.find((g) => g.title === t);

test("resolveDate checks the weekday and picks the nearest year", () => {
  assert.equal(resolveDate("Thursday", 1, 9, "2026-09-30"), "2026-10-01");
  assert.equal(resolveDate("Friday", 1, 9, "2026-09-30"), null); // 1 Oct 2026 is a Thursday
});

test("day headers: month comes from the preceding month heading, weekday/date reconciled", () => {
  const dates = parsed.headers.map((h) => h.date);
  assert.deepEqual(dates.slice(0, 4), ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.ok(parsed.headers.every((h) => h.ok));
  assert.equal(dates.at(-1), "2026-10-08");
});

test("deterministic parse is reliable on the fixture and every gig passes the gate", () => {
  assert.equal(parseIsReliable(parsed), true);
  assert.ok(parsed.gigs.length >= 20);
  for (const g of parsed.gigs) assert.deepEqual(gateGig(g, G), { ok: true }, g.title);
});

test("gig fields: title, times, price words, eventbrite link without query", () => {
  const g = byTitle("Colin Steele Trio");
  assert.equal(g.date, "2026-10-02");
  assert.equal(g.time, "18:15");
  assert.equal(g.endTime, "20:30");
  assert.match(g.price_text, /^£12 ADV or on the door/);
  assert.equal(g.tickets, "https://www.eventbrite.com/e/jazz-bar-friday-colin-steele-trio-jazz-straight-ahead-tickets-2002389051556");
  const row = buildGigRow(g, { postLink: "https://www.thejazzbar.co.uk/post/", now: NOW });
  assert.equal(row.starts_at, "2026-10-02T17:15:00.000Z"); // 18:15 BST
  assert.equal(row.ends_at, "2026-10-02T19:30:00.000Z");
  assert.equal(row.price_from, 12);
  assert.equal(row.is_free, false);
  assert.equal(row.category, "music");
  assert.equal(row.venue_name, "The Jazz Bar");
  assert.equal(row.ticket_url, g.tickets);
  assert.equal(row.provider_event_id, "2026-10-02-1815-colin-steele-trio");
});

test("gig without an eventbrite link falls back to the post link; free entry parsed", () => {
  const g = byTitle("Hot Tin Roof");
  const row = buildGigRow(g, { postLink: "https://www.thejazzbar.co.uk/post/", now: NOW });
  assert.equal(row.ticket_url, "https://www.thejazzbar.co.uk/post/");
  assert.equal(row.is_free, true);
  assert.equal(row.price_from, 0);
});

test("late-night set under Friday's header starts on Saturday's calendar day", () => {
  const g = byTitle("Los Chichanos");
  assert.equal(g.date, "2026-10-02");
  const row = buildGigRow(g, { postLink: "https://x/", now: NOW });
  assert.equal(row.starts_at, "2026-10-02T23:30:00.000Z"); // 00:30 BST on 3 Oct
  assert.equal(row.ends_at, "2026-10-03T02:00:00.000Z"); // 03:00 BST
  assert.equal(row.provider_event_id, "2026-10-02-0030-los-chichanos");
});

test("ALL-CAPS titles are title-cased", () => {
  const row = buildGigRow(byTitle("JOHN HUNT’S BLUES AND SWING EVENING"), { postLink: "https://x/", now: NOW });
  assert.equal(row.name, "John Hunt’s Blues And Swing Evening");
});

test("gate rejects: made-up quote, wrong date, absent time, price figure not in quote", () => {
  const good = { ...byTitle("Colin Steele Trio") };
  assert.equal(gateGig({ ...good, quote: "Colin Steele Trio 18:15 – 20:30, £99 ADV" }, G).reason, "quote_not_found");
  assert.equal(gateGig({ ...good, date: "2026-10-03" }, G).reason, "date_mismatch");
  assert.equal(gateGig({ ...good, time: "19:45" }, G).reason, "time_not_in_quote");
  assert.equal(gateGig({ ...good, price_text: "£15" }, G).reason, "price_not_in_quote");
  assert.equal(gateGig({ ...good, title: "Someone Else" }, G).reason, "title_not_in_quote");
  assert.equal(gateGig({ ...good, quote: "x".repeat(600) }, G).reason, "quote_too_long");
});

test("gate accepts a quote that repeats weekly only for the header it sits under", () => {
  const big = parsed.gigs.filter((g) => /17-Piece/i.test(g.title));
  assert.ok(big.length >= 1);
  for (const g of big) assert.equal(gateGig(g, G).ok, true);
  assert.equal(gateGig({ ...big[0], date: "2026-10-02" }, G).reason, "date_mismatch");
});

test("parseGigPrice", () => {
  assert.deepEqual(parseGigPrice("£5/7 tickets only available on the door (FREE to play!)"), { isFree: false, priceFrom: 5 });
  assert.deepEqual(parseGigPrice("FREE for students before 19:30 – or £6/8"), { isFree: false, priceFrom: 6 });
  assert.deepEqual(parseGigPrice("£8 Child, £9 Adult, babies under 6 months free."), { isFree: false, priceFrom: 8 });
  assert.deepEqual(parseGigPrice("Free entry!"), { isFree: true, priceFrom: 0 });
  assert.deepEqual(parseGigPrice("FREE to play"), { isFree: null, priceFrom: null });
  assert.deepEqual(parseGigPrice(null), { isFree: null, priceFrom: null });
});

test("unreliable markup is detected (so the LLM fallback would run)", () => {
  const junk = htmlToLines("<h4>*** FRIDAY 2nd ***</h4><h2>Some Band</h2><p>doors open late, see you there</p><h2>Other Band</h2><p>nothing</p><h2>Third</h2>");
  const p = parseListings(junk, "2026-09-30");
  assert.equal(parseIsReliable(p), false);
});
