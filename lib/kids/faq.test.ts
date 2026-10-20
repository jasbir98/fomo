// Run with `npx tsx --test lib/kids/faq.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { faqJsonLd, kidsFaq, upcomingSchoolHolidays } from "@/lib/kids/faq";

test("school holidays: a finished one drops out", () => {
  assert.equal(upcomingSchoolHolidays("2026-10-20").length, 2);
  assert.deepEqual(upcomingSchoolHolidays("2027-01-06").map((h) => h.name), ["February mid-term break"]);
  assert.equal(upcomingSchoolHolidays("2027-03-01").length, 0);
});

test("faq: holiday answer quotes the dates, and falls back when none are left", () => {
  const now = kidsFaq("2026-10-20").find((f) => f.question.includes("school holidays"))!;
  assert.match(now.answer, /21 December 2026 to 5 January 2027/);
  assert.match(now.answer, /15 to 19 February 2027/);
  const later = kidsFaq("2027-03-01").find((f) => f.question.includes("school holidays"))!;
  assert.doesNotMatch(later.answer, /2027 to|February mid-term/);
});

test("faq json-ld: FAQPage with one Question per item", () => {
  const items = kidsFaq("2026-10-20");
  const ld = faqJsonLd(items) as { "@type": string; mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
  assert.equal(ld["@type"], "FAQPage");
  assert.equal(ld.mainEntity.length, items.length);
  assert.equal(ld.mainEntity[0].name, items[0].question);
  assert.equal(ld.mainEntity[0].acceptedAnswer.text, items[0].answer);
  JSON.parse(JSON.stringify(ld));
});
