import { test } from "node:test";
import assert from "node:assert/strict";
import { dealCardTitle, dealGroupSubtitle, dealSubtitle, stripVenuePrefix, type DealLabelFields } from "@/lib/happenings/deal-label";

function deal(over: Partial<DealLabelFields>): DealLabelFields {
  return {
    title: "Deal",
    venue_name: null,
    saving_label: null,
    saving_amount: null,
    currency: "GBP",
    is_free: false,
    eligibility: "anyone",
    ...over,
  };
}

test("stripVenuePrefix drops the venue run but never the whole text", () => {
  assert.equal(stripVenuePrefix("ASK Italian 30% Off Food", "ASK Italian Edinburgh"), "30% Off Food");
  assert.equal(stripVenuePrefix("Bar 50", "Bar 50"), "Bar 50");
  assert.equal(stripVenuePrefix("20% off", "Camera Obscura"), "20% off");
});

test("dealSubtitle: offer in plain words, venue stripped, who appended", () => {
  assert.equal(dealSubtitle(deal({ venue_name: "Zizzi", saving_label: "30% Off Food", eligibility: "student" })), "30% off food · Students");
  assert.equal(dealSubtitle(deal({ saving_label: "20% off", eligibility: "local_resident" })), "20% off · EH residents");
  assert.equal(dealSubtitle(deal({ saving_label: "10% discount on your first music lesson", eligibility: "local_resident" })), "10% off · EH residents");
  assert.equal(dealSubtitle(deal({ saving_label: "20%", eligibility: "student" })), "20% off · Students");
  assert.equal(dealSubtitle(deal({ saving_label: "Save up to 57%" })), "Up to 57% off");
  assert.equal(dealSubtitle(deal({ saving_label: "£20.00" })), "£20");
});

test("dealSubtitle: long clause falls back to the short badge; no repeated who", () => {
  assert.equal(
    dealSubtitle(deal({ saving_label: "One free child ticket with each full-paying adult", eligibility: "local_resident" })),
    "Kids free · EH residents"
  );
  assert.equal(dealSubtitle(deal({ saving_label: "10% Student Discount", eligibility: "student" })), "10% off · Students");
});

test("dealSubtitle: no saving data uses the title minus venue, else who, else null", () => {
  assert.equal(dealSubtitle(deal({ title: "Bar 50 Pizza for 2", venue_name: "Bar 50" })), "Pizza for 2");
  assert.equal(dealSubtitle(deal({ title: "Giants", venue_name: "Giants", eligibility: "over_60" })), "Over 60");
  assert.equal(dealSubtitle(deal({ title: "X", venue_name: "X" })), null);
});

test("dealGroupSubtitle: best offer, 'Up to' when offers differ, no badge echo", () => {
  const a = deal({ saving_label: "30% Off Food", saving_amount: 30 });
  const b = deal({ saving_label: "15% off drinks", saving_amount: 15 });
  assert.equal(dealGroupSubtitle([a, b]), "Up to 30% off");
  const c = deal({ saving_label: "20% off", eligibility: "local_resident" });
  const d = deal({ saving_label: "One free child ticket with each full-paying adult", eligibility: "local_resident" });
  assert.equal(dealGroupSubtitle([c, d]), "Up to 20% off · EH residents");
  assert.equal(dealGroupSubtitle([c, c]), "20% off · EH residents");
  assert.ok(!/deals/.test(dealGroupSubtitle([a, b]) ?? ""));
});

test("dealCardTitle prefers venue, then group fallback, then deal title", () => {
  assert.equal(dealCardTitle({ title: "T", venue_name: "V" }), "V");
  assert.equal(dealCardTitle({ title: "T", venue_name: null }, "P"), "P");
  assert.equal(dealCardTitle({ title: "T", venue_name: null }), "T");
});

test("venue-less deals: venue taken from 'at <venue>', subtitle never echoes the title", () => {
  const h = deal({ title: "EH Residents 20% off at 1802 Lounge & Grill", saving_label: "20% off food and drink", eligibility: "local_resident" });
  assert.equal(dealCardTitle(h), "1802 Lounge & Grill");
  assert.equal(dealSubtitle(h), "20% off food and drink · EH residents");
  const r = deal({ title: "Resident Day: Silver Sunday", eligibility: "local_resident" });
  assert.equal(dealCardTitle(r), "Resident Day: Silver Sunday");
  assert.equal(dealSubtitle(r), "EH residents");
});
