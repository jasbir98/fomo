import { test } from "node:test";
import assert from "node:assert/strict";
import { icsDateToIso, mapIcsEvent, parseIcsEvents, unescapeIcsText, unfoldIcs } from "./ical.mjs";

// Inline fixture: CRLF line endings, a folded DESCRIPTION, escaped SUMMARY,
// London local time, UTC, all-day, a cancelled event, a recurring series and
// a non-London TZID.
const FIXTURE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:gig-1@example.test",
  "DTSTART;TZID=Europe/London:20261010T193000",
  "DTEND;TZID=Europe/London:20261010T220000",
  "SUMMARY:Jazz\\, Blues\\; Night",
  "DESCRIPTION:A long evening of live music with\\nspecial guests and a very",
  " long description that is folded across lines.",
  "URL:https://venue.example.test/events/gig-1",
  "LOCATION:Main Room\\, 1 Example Street",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:utc-2@example.test",
  "DTSTART:20261212T120000Z",
  "SUMMARY:Winter Market",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:allday-3@example.test",
  "DTSTART;VALUE=DATE:20261031",
  "SUMMARY:Halloween Party",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:cancelled-4@example.test",
  "DTSTART:20261015T190000",
  "STATUS:CANCELLED",
  "SUMMARY:Cancelled Night",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:series-5@example.test",
  "DTSTART:20261020T190000",
  "RRULE:FREQ=WEEKLY;COUNT=4",
  "SUMMARY:Weekly Quiz",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:ny-6@example.test",
  "DTSTART;TZID=America/New_York:20261010T190000",
  "SUMMARY:Elsewhere",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const NOW = new Date("2026-01-01T00:00:00Z");
const VENUE = { venue_name: "Example Venue", address: "1 Example Street, Edinburgh", city: "Edinburgh", lat: 55.95, lng: -3.19 };

test("unfoldIcs joins folded continuation lines", () => {
  const lines = unfoldIcs("DESCRIPTION:abc\r\n def\r\nSUMMARY:x");
  assert.deepEqual(lines, ["DESCRIPTION:abcdef", "SUMMARY:x"]);
});

test("unescapeIcsText handles \\n, \\, \\; and \\\\", () => {
  assert.equal(unescapeIcsText("a\\, b\\; c\\nd\\\\e"), "a, b; c\nd\\e");
});

test("icsDateToIso: London local time during BST converts to UTC", () => {
  assert.deepEqual(icsDateToIso("20261010T193000", { TZID: "Europe/London" }), { iso: "2026-10-10T18:30:00.000Z", allDay: false });
});

test("icsDateToIso: floating local time is treated as London", () => {
  assert.equal(icsDateToIso("20261212T120000").iso, "2026-12-12T12:00:00.000Z");
});

test("icsDateToIso: Z suffix is taken as UTC", () => {
  assert.equal(icsDateToIso("20261212T120000Z").iso, "2026-12-12T12:00:00.000Z");
});

test("icsDateToIso: VALUE=DATE is London midnight, all-day", () => {
  // 31 Oct 2026 is after BST ends (25 Oct), so London midnight is 00:00Z.
  assert.deepEqual(icsDateToIso("20261031", { VALUE: "DATE" }), { iso: "2026-10-31T00:00:00.000Z", allDay: true });
});

test("icsDateToIso: unsupported TZID and garbage return null", () => {
  assert.equal(icsDateToIso("20261010T190000", { TZID: "America/New_York" }), null);
  assert.equal(icsDateToIso("not-a-date"), null);
});

test("parseIcsEvents returns one object per VEVENT with params kept", () => {
  const events = parseIcsEvents(FIXTURE);
  assert.equal(events.length, 6);
  assert.equal(events[0].UID.value, "gig-1@example.test");
  assert.equal(events[0].DTSTART.params.TZID, "Europe/London");
  assert.equal(events[2].DTSTART.params.VALUE, "DATE");
});

test("mapIcsEvent maps a full London-time event", () => {
  const events = parseIcsEvents(FIXTURE);
  const { row, reason } = mapIcsEvent(events[0], { provider: "example", venue: VENUE, destination: "Edinburgh", now: NOW });
  assert.equal(reason, null);
  assert.equal(row.provider, "example");
  assert.equal(row.provider_event_id, "gig-1@example.test");
  assert.equal(row.name, "Jazz, Blues; Night");
  assert.equal(row.starts_at, "2026-10-10T18:30:00.000Z");
  assert.equal(row.ends_at, "2026-10-10T21:00:00.000Z");
  assert.equal(row.ticket_url, "https://venue.example.test/events/gig-1");
  assert.equal(row.address, "1 Example Street, Edinburgh");
  assert.equal(row.venue_name, "Example Venue");
  assert.equal(row.country, "GB");
  assert.equal(row.source, "api");
  assert.equal(row.fetched_at, NOW.toISOString());
});

test("mapIcsEvent: missing DTEND gives null ends_at; UTC event maps", () => {
  const events = parseIcsEvents(FIXTURE);
  const { row } = mapIcsEvent(events[1], { provider: "example", venue: VENUE, destination: "Edinburgh", now: NOW });
  assert.equal(row.ends_at, null);
  assert.equal(row.starts_at, "2026-12-12T12:00:00.000Z");
});

test("mapIcsEvent: all-day VEVENT maps to London midnight", () => {
  const events = parseIcsEvents(FIXTURE);
  const { row } = mapIcsEvent(events[2], { provider: "example", venue: VENUE, destination: "Edinburgh", now: NOW });
  assert.equal(row.starts_at, "2026-10-31T00:00:00.000Z");
});

test("mapIcsEvent skips cancelled, recurring and unsupported-TZID events", () => {
  const events = parseIcsEvents(FIXTURE);
  const opts = { provider: "example", venue: VENUE, destination: "Edinburgh", now: NOW };
  assert.deepEqual(mapIcsEvent(events[3], opts), { row: null, reason: "invalid" });
  assert.deepEqual(mapIcsEvent(events[4], opts), { row: null, reason: "invalid" });
  assert.deepEqual(mapIcsEvent(events[5], opts), { row: null, reason: "invalid" });
});

test("mapIcsEvent skips events already started before now", () => {
  const events = parseIcsEvents(FIXTURE);
  const { row, reason } = mapIcsEvent(events[0], { provider: "example", venue: VENUE, destination: "Edinburgh", now: new Date("2026-11-01T00:00:00Z") });
  assert.equal(row, null);
  assert.equal(reason, "past");
});
