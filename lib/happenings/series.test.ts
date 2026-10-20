// Run: npx tsx --test lib/happenings/series.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Happening } from "./types";
import { groupHappeningsIntoSeries } from "./series";

function hap(id: string, title: string, fields: Partial<Happening> = {}): Happening {
  return {
    id,
    title,
    kind: "activity",
    category: "outdoors",
    source_name: "parkrun.org.uk",
    booking_url: null,
    venue_name: null,
    district: null,
    address: null,
    ...fields,
  } as unknown as Happening;
}

// The three live rows as stored on 20 Oct 2026: only Holyrood has a
// booking_url, and its source_name is a label rather than the domain.
const cramond = hap("cramond", "Cramond Promenade Saturday parkrun", { venue_name: "Cramond / Silverknowes Promenade", district: "Cramond" });
const portobello = hap("portobello", "Portobello parkrun at Figgate Park", { venue_name: "Figgate Park", district: "Portobello" });
const holyrood = hap("holyrood", "Holyrood parkrun around Arthur's Seat", {
  venue_name: "Holyrood Park",
  district: "Holyrood",
  source_name: "parkrun UK — Holyrood parkrun",
  booking_url: "https://www.parkrun.org.uk/holyrood/",
});

test("all three Edinburgh parkruns group, whichever way their organiser is recorded", () => {
  const groups = groupHappeningsIntoSeries([cramond, holyrood, portobello]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members.map((m) => m.id).sort(), ["cramond", "holyrood", "portobello"]);
});

test("a source_name that is a label, not a domain, still needs an exact match", () => {
  const a = hap("a", "Bookbug at Leith Library", { kind: "activity", category: "family", source_name: "Leith Library" });
  const b = hap("b", "Bookbug at Stockbridge Library", { kind: "activity", category: "family", source_name: "Stockbridge Library" });
  assert.equal(groupHappeningsIntoSeries([a, b]).length, 0);
});

test("a different domain does not group", () => {
  const other = hap("other", "Inverleith parkrun-style fun run", { source_name: "funruns.example.com" });
  const groups = groupHappeningsIntoSeries([cramond, other]);
  assert.equal(groups.length, 0);
});
