// Run: npx tsx --test lib/happenings/deal-score.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Happening } from "./types";
import { dealDepth, dealStealScore, isNationalChain } from "./deal-score";

function deal(over: Partial<Happening>): Pick<Happening, "title" | "venue_name" | "saving_label" | "priority" | "recurrence"> {
  return { title: "Deal", venue_name: null, saving_label: null, priority: 50, recurrence: { type: "always" }, ...over } as Happening;
}

test("isNationalChain: hits chains by venue name, curly apostrophes and title-only schemes", () => {
  assert.equal(isNationalChain({ title: "Student discount", venue_name: "ASK Italian Edinburgh" }), true);
  assert.equal(isNationalChain({ title: "Student discount", venue_name: "Slug and Lettuce" }), true);
  assert.equal(isNationalChain({ title: "Student discount", venue_name: "O’Neill’s" }), true);
  assert.equal(isNationalChain({ title: "Lothian & Trams Student Ridacard", venue_name: null }), true);
});

test("isNationalChain: local places and substrings of chain names are not chains", () => {
  assert.equal(isNationalChain({ title: "Student discount", venue_name: "Biddy Mulligans" }), false);
  assert.equal(isNationalChain({ title: "Photography walk", venue_name: null }), false);
  assert.equal(isNationalChain({ title: "Student discount", venue_name: "The Lioness of Leith" }), false);
});

test("dealDepth reads percentages, 2-for-1, freebies and prices", () => {
  assert.equal(dealDepth({ title: "Deal", saving_label: "Save up to 57%" }), 57);
  assert.equal(dealDepth({ title: "Deal", saving_label: "2 for 1" }), 50);
  assert.equal(dealDepth({ title: "Deal", saving_label: "complimentary drink" }), 40);
  assert.equal(dealDepth({ title: "Deal", saving_label: "£5 off" }), 20);
  assert.equal(dealDepth({ title: "Deal", saving_label: "£3 per ticket" }), 40);
  assert.equal(dealDepth({ title: "Deal", saving_label: "1/3 off rail travel" }), 33);
  assert.equal(dealDepth({ title: "Deal", saving_label: null }), 10);
});

test("dealStealScore: a local Tuesday-only 20% deal beats a chain's 50% Mon-Thu", () => {
  const local = deal({ title: "Student night", venue_name: "Biddy Mulligans", saving_label: "20% off", recurrence: { type: "weekly", days: [2] } });
  const chain = deal({ title: "ASK Italian 50% Off Mains", venue_name: "ASK Italian", saving_label: "50% off", recurrence: { type: "weekly", days: [1, 2, 3, 4] } });
  assert.ok(dealStealScore(local) > dealStealScore(chain));
});
