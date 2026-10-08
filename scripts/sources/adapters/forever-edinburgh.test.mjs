import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildRow,
  categoryFromTermIds,
  isCandidate,
  londonWallToIso,
  pageContentHash,
  parseEventPage,
  parsePriceText,
  parseSiteDate,
  parseTimeFromText,
} from "./forever-edinburgh.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (id) => readFileSync(path.join(dir, `forever-edinburgh-${id}.html`), "utf8");
const NOW = new Date("2026-10-08T10:00:00Z");

test("parseSiteDate", () => {
  assert.equal(parseSiteDate("25/10/2026"), "2026-10-25");
  assert.equal(parseSiteDate("5/7/2026"), "2026-07-05");
  assert.equal(parseSiteDate("31/02/2026"), null);
  assert.equal(parseSiteDate("garbage"), null);
});

test("parseTimeFromText: explicit phrases only", () => {
  assert.deepEqual(parseTimeFromText("Running from 4pm to 6pm at Moonwake Beer Co"), { start: "16:00", end: "18:00" });
  assert.deepEqual(parseTimeFromText("The concert, which runs from 1pm to 2pm on 16 October 2026 is free"), { start: "13:00", end: "14:00" });
  assert.deepEqual(parseTimeFromText("Starts at 7.30pm"), { start: "19:30", end: null });
  assert.deepEqual(parseTimeFromText("doors 19:00"), { start: "19:00", end: null });
});

test("parseTimeFromText: ambiguous or absent gives null", () => {
  assert.equal(parseTimeFromText("Running every day at 11am and 2pm"), null);
  assert.equal(parseTimeFromText("Runs from 10am to 4pm. Starts at 2pm"), null); // two distinct starts
  assert.equal(parseTimeFromText("Tickets from £35.00 per person"), null);
  assert.equal(parseTimeFromText("Book 2 weeks ahead"), null);
});

test("londonWallToIso handles BST and GMT", () => {
  assert.equal(londonWallToIso("2026-10-25", "16:00"), "2026-10-25T16:00:00.000Z"); // BST ended 25 Oct 01:00
  assert.equal(londonWallToIso("2026-10-10", "16:00"), "2026-10-10T15:00:00.000Z"); // BST
});

test("parsePriceText", () => {
  assert.deepEqual(parsePriceText("£14.00 per person"), { isFree: false, priceFrom: 14 });
  assert.deepEqual(parsePriceText("From £12.00 to £15.00 + booking fee per person"), { isFree: false, priceFrom: 12 });
  assert.deepEqual(parsePriceText("Free admission; booking required"), { isFree: true, priceFrom: 0 });
  assert.deepEqual(parsePriceText("See website for ticket prices"), { isFree: null, priceFrom: null });
  assert.deepEqual(parsePriceText(null), { isFree: null, priceFrom: null });
});

test("categoryFromTermIds", () => {
  assert.equal(categoryFromTermIds([880, 879]), "music");
  assert.equal(categoryFromTermIds([881, 876]), "arts");
  assert.equal(categoryFromTermIds([880]), "other");
});

test("single-day page with prose time (fixture 23285)", () => {
  const p = parseEventPage(fx("23285"));
  assert.equal(p.startDate, "2026-10-25");
  assert.equal(p.endDate, "2026-10-25");
  assert.equal(p.venueName, "Moonwake Beer Co");
  assert.equal(p.address, "Moonwake Beer Co, 6A Tower Street, Edinburgh, EH6 7BY");
  assert.equal(p.lat, 55.97736239);
  assert.equal(p.priceText, "£14.00 per person");
  assert.match(p.bookingUrl, /eventbrite\.com/);
  const item = { title: { rendered: "Skip the Small Talk" }, link: "https://edinburgh.org/event/skip-the-small-talk/", event_category: [884] };
  const { row } = buildRow(item, p, { now: NOW });
  assert.equal(row.provider_event_id, "https://edinburgh.org/event/skip-the-small-talk");
  assert.equal(row.starts_at, "2026-10-25T16:00:00.000Z"); // 4pm GMT after clocks go back
  assert.equal(row.ends_at, "2026-10-25T18:00:00.000Z");
  assert.equal(row.price_from, 14);
  assert.equal(row.is_free, false);
  assert.equal(row.category, "food");
  assert.match(row.ticket_url, /eventbrite/);
});

test("two-day range gives one row start..end, date-only (fixture 39715)", () => {
  const p = parseEventPage(fx("39715"));
  assert.equal(p.startDate, "2026-10-17");
  assert.equal(p.endDate, "2026-10-18");
  const { row } = buildRow({ title: { rendered: "The Littlest Yak" }, link: "https://edinburgh.org/event/the-littlest-yak/", event_category: [876] }, p, { now: NOW });
  assert.equal(row.starts_at, "2026-10-17T00:00:00.000Z");
  assert.equal(row.ends_at, "2026-10-18T23:59:59.000Z");
});

test("year-long listing is skipped as longRange (fixture 16964)", () => {
  const p = parseEventPage(fx("16964"));
  const r = buildRow({ title: { rendered: "Dr Arnott&#8217;s Sampling Sensation" }, link: "https://edinburgh.org/event/x/", event_category: [] }, p, { now: NOW });
  assert.equal(r.row, null);
  assert.equal(r.reason, "longRange");
});

test("multi-day page ignores prose times (fixture 38437)", () => {
  const p = parseEventPage(fx("38437"));
  const { row } = buildRow({ title: { rendered: "The Long Italian Lunch" }, link: "https://edinburgh.org/event/lunch/", event_category: [884] }, p, { now: NOW });
  assert.equal(row.starts_at, "2026-08-30T00:00:00.000Z");
});

test("free category / free price text (fixture 35593)", () => {
  const p = parseEventPage(fx("35593"));
  const { row } = buildRow({ title: { rendered: "Talk" }, link: "https://edinburgh.org/event/talk/", event_category: [880] }, p, { now: NOW });
  assert.equal(row.is_free, true);
  assert.equal(row.price_from, 0);
});

test("past events are rejected; multi-line address (fixture 38058)", () => {
  const p = parseEventPage(fx("38058"));
  assert.equal(p.venueName, "Scottish Gas Murrayfield Stadium");
  assert.equal(p.address, "Scottish Gas Murrayfield Stadium, 110 Roseburn Street, Edinburgh EH12 5PJ");
  const later = new Date("2026-11-01T10:00:00Z");
  assert.equal(buildRow({ title: { rendered: "Whisky" }, link: "https://edinburgh.org/event/w/", event_category: [] }, p, { now: later }).reason, "past");
});

test("page hash is stable and changes with content", () => {
  const a = pageContentHash(parseEventPage(fx("23285")));
  assert.equal(a, pageContentHash(parseEventPage(fx("23285"))));
  assert.notEqual(a, pageContentHash(parseEventPage(fx("39715"))));
});

test("isCandidate: modified within a year and month classes touching the lookahead window", () => {
  const base = { modified_gmt: "2026-09-01T00:00:00", class_list: ["event_month-10-2026"] };
  assert.equal(isCandidate(base, NOW), true);
  assert.equal(isCandidate({ ...base, class_list: ["event_month-03-2026"] }, NOW), false);
  assert.equal(isCandidate({ ...base, modified_gmt: "2025-01-01T00:00:00" }, NOW), false);
  assert.equal(isCandidate({ ...base, class_list: [] }, NOW), true);
});

test("single-day event with no stated time is date-only but live until end of day (fixture 38058)", () => {
  const p = parseEventPage(fx("38058"));
  const { row } = buildRow({ title: { rendered: "Edinburgh Whisky Festival" }, link: "https://edinburgh.org/event/w/", event_category: [] }, p, { now: NOW });
  assert.equal(row.starts_at, "2026-10-10T00:00:00.000Z");
  assert.equal(row.ends_at, "2026-10-10T23:59:59.000Z");
});
