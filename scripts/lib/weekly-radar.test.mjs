import test from "node:test";
import assert from "node:assert/strict";
import { mondayOf, radarPickForWeek } from "./weekly-picks.mjs";

test("mondayOf: the Monday on or before a day", () => {
  assert.equal(mondayOf("2026-11-13"), "2026-11-09"); // Fri
  assert.equal(mondayOf("2026-11-09"), "2026-11-09");
  assert.equal(mondayOf("2026-11-15"), "2026-11-09"); // Sun
});

test("radarPickForWeek: only an approved pick featured for that week, else null", () => {
  const base = { id: "p1", name: "Tiny Bookshop", category: "bookshop", image_url: null };
  const ok = { ...base, radar_why: " Locals' favourite ", radar_picked_at: "2026-11-02T00:00:00Z", radar_featured_week: "2026-11-09" };
  const out = radarPickForWeek([ok], "2026-11-13");
  assert.equal(out.title, "Tiny Bookshop");
  assert.equal(out.why, "Locals' favourite");
  assert.equal(out.url, "https://askfomo.com/place/p1");
  assert.equal(radarPickForWeek([ok], "2026-11-20"), null, "different week");
  assert.equal(radarPickForWeek([{ ...ok, radar_picked_at: null }], "2026-11-13"), null, "not approved");
  assert.equal(radarPickForWeek([{ ...ok, radar_why: "  " }], "2026-11-13"), null, "no reason");
  assert.equal(radarPickForWeek([], "2026-11-13"), null);
  assert.equal(radarPickForWeek(undefined, "2026-11-13"), null);
});
