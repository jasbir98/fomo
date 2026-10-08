import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRowAgainstHtml, pageHasDate, pageText, significantTokens, titleTokenCoverage } from "./sample-check.mjs";

test("pageHasDate: common formats", () => {
  const yes = (t) => assert.equal(pageHasDate(t.toLowerCase(), "2026-10-09"), true, t);
  yes("Thu 9 Oct 2026");
  yes("Friday 9th October");
  yes("09 October 2026");
  yes("Oct 9, 2026");
  yes("October 9th");
  yes("9/10/2026");
  yes("09.10.26");
  yes("2026-10-09");
  yes("9 of October");
});

test("pageHasDate: does not confuse neighbouring days or months", () => {
  const no = (t) => assert.equal(pageHasDate(t.toLowerCase(), "2026-10-09"), false, t);
  no("19 October 2026");
  no("9 November 2026");
  no("Oct 19");
  no("29/10/2026");
  no("9/11/2026");
  assert.equal(pageHasDate("sept 5", "2026-09-05"), true);
});

test("significantTokens drops venue suffix, stopwords and short words", () => {
  assert.deepEqual(significantTokens("Walter Trout @ Queen's Hall", "Queen's Hall"), ["walter", "trout"]);
  assert.deepEqual(significantTokens("The Big Quiz Live", null), ["big", "quiz"]);
});

test("titleTokenCoverage uses whole-word matching", () => {
  assert.equal(titleTokenCoverage("Comedy Night", null, "a great comedy night out"), 1);
  assert.equal(titleTokenCoverage("Comedy Night", null, "tragedy nights"), 0);
});

test("checkRowAgainstHtml: title + date from a page", () => {
  const html = `<html><head><title>Walter Trout &amp; Band | Tickets</title><script type="application/ld+json">{"startDate":"2026-10-09T19:00"}</script></head><body><h1>Walter Trout</h1><p>Fri 9 Oct</p></body></html>`;
  const r = checkRowAgainstHtml({ name: "Walter Trout & Band", venue_name: null, starts_at: "2026-10-09T18:00:00.000Z" }, html);
  assert.equal(r.pass, true);
  const wrongDate = checkRowAgainstHtml({ name: "Walter Trout", venue_name: null, starts_at: "2026-11-20T19:00:00.000Z" }, html);
  assert.equal(wrongDate.pass, false);
});

test("pageText keeps title/meta text and drops scripts", () => {
  const t = pageText(`<title>Gig &amp; Co</title><meta property="og:description" content="Big Night"><script>var x='hidden'</script><p>Body</p>`);
  assert.ok(t.includes("gig & co") && t.includes("big night") && t.includes("body") && !t.includes("hidden"));
});
