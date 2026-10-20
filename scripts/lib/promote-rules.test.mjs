import test from "node:test";
import assert from "node:assert/strict";
import { protectExistingFields, chunk, inList, ENRICHABLE_FIELDS, isMissingColumnError, withoutColumn } from "./promote-rules.mjs";

const evidence = (quote) => ({ url: "https://example.com/x", quote });

test("a brand-new slug keeps every field", () => {
  const row = { summary: "s", price_text: "£5" };
  const { row: out, kept } = protectExistingFields({ ...row }, null);
  assert.deepEqual(out, row);
  assert.deepEqual(kept, []);
});

test("fields with evidence in enrich_sources are dropped from the payload", () => {
  const { row, kept } = protectExistingFields(
    { slug: "a", title: "T", summary: "new", price_text: "£6", includes: "new includes", time_note: "x" },
    { enrich_sources: { summary: evidence("q1"), price_text: evidence("q2") } },
  );
  assert.equal(row.summary, undefined);
  assert.equal(row.price_text, undefined);
  assert.equal(row.includes, "new includes");
  assert.equal(row.time_note, "x");
  assert.equal(row.title, "T");
  assert.deepEqual(kept.sort(), ["price_text", "summary"]);
});

test("empty or missing evidence does not protect a field", () => {
  const { row } = protectExistingFields(
    { summary: "new", includes: "new", address: "new" },
    { enrich_sources: { summary: {}, includes: null, address: { url: "", quote: " " } } },
  );
  assert.equal(row.summary, "new");
  assert.equal(row.includes, "new");
  assert.equal(row.address, "new");
});

test("non-enrichable keys in enrich_sources are ignored", () => {
  const { row } = protectExistingFields({ title: "new", summary: "new" }, { enrich_sources: { title: evidence("q") } });
  assert.equal(row.title, "new");
  assert.equal(row.summary, "new");
});

test("an existing image is never replaced; a missing one is filled", () => {
  const a = protectExistingFields({ image_url: "https://new/x.jpg" }, { image_url: "https://old/x.jpg", enrich_sources: null });
  assert.equal(a.row.image_url, undefined);
  const b = protectExistingFields({ image_url: "https://new/x.jpg" }, { image_url: null, enrich_sources: null });
  assert.equal(b.row.image_url, "https://new/x.jpg");
});

test("enrichable list matches the enrichment gate fields", () => {
  assert.equal(ENRICHABLE_FIELDS.length, 8);
});

test("chunk and inList", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(inList(["a-b", 'c"d']), '("a-b","c\\"d")');
});

test("isMissingColumnError recognises PostgREST and Postgres missing-column errors for the named column only", () => {
  const rest = `POST happenings?on_conflict=slug → 400: {"code":"PGRST204","message":"Could not find the 'family_fit' column of 'happenings' in the schema cache"}`;
  const pg = `POST happenings → 400: {"code":"42703","message":"column \\"family_fit\\" of relation \\"happenings\\" does not exist"}`;
  assert.equal(isMissingColumnError(rest, "family_fit"), true);
  assert.equal(isMissingColumnError(pg, "family_fit"), true);
  assert.equal(isMissingColumnError(rest, "enrich_sources"), false);
  assert.equal(isMissingColumnError('{"code":"23502","message":"null value in column \\"title\\" violates not-null constraint family_fit"}', "family_fit"), false);
  assert.equal(isMissingColumnError(undefined, "family_fit"), false);
});

test("withoutColumn returns a copy without the column and leaves the original alone", () => {
  const row = { slug: "a", family_fit: "kids", eligibility: "family" };
  assert.deepEqual(withoutColumn(row, "family_fit"), { slug: "a", eligibility: "family" });
  assert.equal(row.family_fit, "kids");
});
