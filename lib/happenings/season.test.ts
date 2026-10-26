// Run: npx tsx --test lib/happenings/season.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Happening } from "./types";
import { festivalSeasonOf, isOutOfSeason, staleEditionYear, titleEditionYears } from "./season";

const TZ = "Europe/London";
const OCT = new Date("2026-10-26T12:00:00Z");
const JULY = new Date("2027-07-10T12:00:00Z");

function hap(over: Partial<Happening> & Pick<Happening, "id" | "title" | "recurrence">): Happening {
  return {
    summary: null,
    source_name: "Somewhere",
    kind: "event",
    starts_at: null,
    ends_at: null,
    status: "live",
    ...over,
  } as Happening;
}

test("titleEditionYears: single years, season ranges, dates aren't ranges", () => {
  assert.deepEqual(titleEditionYears("Edinburgh Marathon 2026 entry"), [{ start: 2026, end: 2026 }]);
  assert.deepEqual(titleEditionYears("Edinburgh's Hogmanay 2026/27"), [{ start: 2026, end: 2027 }]);
  assert.deepEqual(titleEditionYears("Capitals SNL 2026-27 Season Ticket"), [{ start: 2026, end: 2027 }]);
  assert.deepEqual(titleEditionYears("Gig 2026-12-29"), [{ start: 2026, end: 2026 }]);
  assert.deepEqual(titleEditionYears("No year here"), []);
});

test("staleEditionYear", () => {
  assert.equal(staleEditionYear("Edinburgh Marathon 2026 entry", 2027, false), true);
  assert.equal(staleEditionYear("Tattoo 2027 Tickets On Sale Now", 2027, false), false);
  assert.equal(staleEditionYear("The Scotland Experience 2027 Hospitality", 2026, false), false);
  // A dated season row is the edition that starts in its first year.
  assert.equal(staleEditionYear("Edinburgh's Hogmanay 2026/27", 2026, false), false);
  assert.equal(staleEditionYear("Edinburgh's Hogmanay 2026/27", 2027, false), true);
  // An always row lasts until the range's end.
  assert.equal(staleEditionYear("Edinburgh City 2026/27 SPFL 2 fixtures", 2027, true), false);
  assert.equal(staleEditionYear("Edinburgh City 2026/27 SPFL 2 fixtures", 2028, true), true);
  // A year that's a name, not an edition.
  assert.equal(staleEditionYear("Back to 2009 Night", 2026, false), false);
});

test("annual event whose title names a past edition is out of season", () => {
  const marathon = hap({ id: "m", title: "Edinburgh Marathon 2026 entry", recurrence: { type: "annual", month: 5, day: 24 } });
  const lineup = hap({ id: "l", title: "2026 Made in Scotland Lineup Released", recurrence: { type: "annual", month: 8, day: 7, endDay: 31 } });
  const halfNoYear = hap({ id: "h", title: "Edinburgh Half Marathon Good for Age entry", recurrence: { type: "annual", month: 5, day: 24 } });
  assert.equal(isOutOfSeason(marathon, OCT, TZ), true);
  assert.equal(isOutOfSeason(lineup, OCT, TZ), true);
  assert.equal(isOutOfSeason(halfNoYear, OCT, TZ), false);
});

test("always rows tied to the August festivals only show 1 Jul - 31 Aug", () => {
  const pass = hap({ id: "p", kind: "free_access", title: "EIF Free Young Musicians Pass Tickets", source_name: "Edinburgh International Festival", recurrence: { type: "always" } });
  const viaSummary = hap({ id: "y", kind: "deal", title: "Young Musician's Pass", summary: "Free pairs of tickets for selected International Festival music performances.", source_name: "Edinburgh Festival City", recurrence: { type: "always" } });
  const museum = hap({ id: "n", kind: "free_access", title: "National Museum of Scotland Free Entry", recurrence: { type: "always" } });
  assert.ok(festivalSeasonOf(pass));
  assert.equal(isOutOfSeason(pass, OCT, TZ), true);
  assert.equal(isOutOfSeason(viaSummary, OCT, TZ), true);
  assert.equal(isOutOfSeason(pass, JULY, TZ), false);
  assert.equal(isOutOfSeason(museum, OCT, TZ), false);
});

test("annual deals only show within 45 days of their window", () => {
  const fringe = hap({ id: "f", kind: "deal", title: "Edinburgh Fringe Student Concession Tickets", recurrence: { type: "annual", month: 8, day: 1, endDay: 31 } });
  assert.equal(isOutOfSeason(fringe, OCT, TZ), true);
  assert.equal(isOutOfSeason(fringe, JULY, TZ), false);
  // Annual events and festivals keep their full Book early lead time.
  const tattoo = hap({ id: "t", kind: "festival", title: "Royal Edinburgh Military Tattoo", recurrence: { type: "annual", month: 8, day: 6, endDay: 28 } });
  assert.equal(isOutOfSeason(tattoo, OCT, TZ), false);
});
