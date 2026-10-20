import { test } from "node:test";
import assert from "node:assert/strict";
import { mapSkiddleEvent } from "./skiddle.mjs";
import { isFestivalKidsEvent } from "./festivals-api.mjs";
import { mapJsonLdEvent } from "../core/jsonld.mjs";
import { dedupeAcrossSources } from "../core/dedupe.mjs";

const now = new Date("2026-10-20T10:00:00Z");

test("skiddle: KIDS eventcode sets family_fit, others leave it unset", () => {
  const base = { id: 1, eventname: "Puppet Show", startdate: "2026-11-01 10:00:00", venue: { name: "V", town: "Edinburgh" } };
  assert.equal(mapSkiddleEvent({ ...base, eventcode: "KIDS" }, { destination: "edinburgh", now }).row.family_fit, "kids");
  assert.equal("family_fit" in mapSkiddleEvent({ ...base, eventcode: "LIVE" }, { destination: "edinburgh", now }).row, false);
});

test("festivals: imaginate festival and children/family genres are kids signals", () => {
  assert.equal(isFestivalKidsEvent({ festival_id: "imaginate" }), true);
  assert.equal(isFestivalKidsEvent({ festival_id: "fringe", genre: "Children's Shows" }), true);
  assert.equal(isFestivalKidsEvent({ festival_id: "fringe", genre_tags: ["Family"] }), true);
  assert.equal(isFestivalKidsEvent({ festival_id: "fringe", genre: "Comedy" }), false);
});

test("jsonld: ChildrensEvent type sets family_fit", () => {
  const obj = (type) => ({ "@type": type, name: "Show", startDate: "2026-11-01T10:00:00Z", url: "https://x.test/e/1", location: { name: "V" } });
  const kid = mapJsonLdEvent(obj("ChildrensEvent"), { provider: "t", pageUrl: "https://x.test/", destination: "edinburgh", now }).row;
  const other = mapJsonLdEvent(obj("MusicEvent"), { provider: "t", pageUrl: "https://x.test/", destination: "edinburgh", now }).row;
  assert.equal(kid.family_fit, "kids");
  assert.equal("family_fit" in other, false);
});

test("dedupe: a kids signal on the dropped copy survives onto the kept row", () => {
  const a = { provider: "skiddle", provider_event_id: "1", name: "Puppets", venue_name: "V", starts_at: "2026-11-01T10:00:00Z", price_from: 5, family_fit: null };
  const b = { provider: "allevents", provider_event_id: "2", name: "Puppets", venue_name: "V", starts_at: "2026-11-01T10:00:00Z", price_from: null, family_fit: "kids" };
  const { rows } = dedupeAcrossSources([a, b]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "skiddle");
  assert.equal(rows[0].family_fit, "kids");
});
