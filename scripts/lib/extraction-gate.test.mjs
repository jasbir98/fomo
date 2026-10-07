import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanValue, gateExtraction, gateField, moneyFigures, normalise } from "./extraction-gate.mjs";

const PAGE_TEXT = `Bar 50 deals\nPizza or burger, a side and a drink each – just £20 for two!\nOpen Mon–Fri 12​:00 to 22:00.\nIt’s 50p extra for a dip.`;
const page = { status: "ok", text: PAGE_TEXT, final_url: "https://bar50.example/deals", url: "https://bar50.example/" };
const norm = normalise(PAGE_TEXT);
const gate = (field, proposal) => gateField(field, proposal, norm, page.final_url);

test("normalise: lowercase, ascii quotes/dashes, no zero-width, collapsed whitespace", () => {
  assert.equal(normalise("It’s  A–B “ok”​"), `it's a-b "ok"`);
});

test("moneyFigures: pounds, decimals, pence; 12pm is not pence", () => {
  assert.deepEqual([...moneyFigures("£12 or £12.50, £1,200, 50p, 7pm, £20.00")].sort(), ["£1200", "£12", "£12.5", "£20", "50p"].sort());
  assert.equal(moneyFigures("at 12pm").size, 0);
});

test("cleanValue replaces em dashes with a comma", () => {
  assert.equal(cleanValue("Two meals — one drink"), "Two meals, one drink");
  assert.equal(cleanValue("a—b"), "a, b");
});

test("null value is skipped", () => {
  assert.deepEqual(gate("price_text", { value: null, quote: null, url: null }), { skipped: true });
});

test("accepts a quote found after normalisation, with page url fallback", () => {
  const r = gate("price_text", { value: "£20 for two", quote: "A drink each - just £20 for two!", url: null });
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://bar50.example/deals");
  const r2 = gate("time_note", { value: "Mon-Fri 12:00-22:00", quote: "Open Mon-Fri 12:00 to 22:00", url: "https://bar50.example/hours" });
  assert.equal(r2.ok, true);
  assert.equal(r2.url, "https://bar50.example/hours");
});

test("rejects missing, empty, or absent quotes", () => {
  assert.equal(gate("includes", { value: "x", quote: null }).reason, "no quote");
  assert.equal(gate("includes", { value: "x", quote: "   " }).reason, "no quote");
  assert.equal(gate("includes", { value: "x", quote: "free champagne for everyone" }).reason, "quote not found in page text");
});

test("rejects a figure that is not in the quote", () => {
  const r = gate("price_text", { value: "£15 for two", quote: "A drink each - just £20 for two" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /£15/);
  // figure on the page but not in the quote still fails
  const r2 = gate("price_text", { value: "£20 for two plus 50p extra", quote: "just £20 for two" });
  assert.match(r2.reason, /50p/);
});

test("£20.00 in value matches £20 in quote", () => {
  assert.equal(gate("price_text", { value: "£20.00 for two", quote: "just £20 for two" }).ok, true);
});

test("length caps per field", () => {
  const long = "a".repeat(161);
  const pageLong = normalise(long);
  assert.match(gateField("summary", { value: long, quote: long }, pageLong, null).reason, /too long/);
  assert.equal(gateField("summary", { value: "a".repeat(160), quote: long }, pageLong, null).ok, true);
  const p61 = "b".repeat(61);
  assert.match(gateField("price_text", { value: p61, quote: p61 }, normalise(p61), null).reason, /too long/);
  assert.equal(gateField("redemption_note", { value: "c".repeat(200), quote: "c".repeat(200) }, "c".repeat(200), null).ok, true);
});

test("em dash is replaced, not rejected", () => {
  const r = gate("includes", { value: "Pizza or burger — a side and a drink each", quote: "Pizza or burger, a side and a drink each" });
  assert.equal(r.ok, true);
  assert.equal(r.value, "Pizza or burger, a side and a drink each");
});

test("rejects unknown fields and oversize quotes", () => {
  assert.equal(gate("rating", { value: "5", quote: "x" }).reason, "unknown field");
  const big = "z".repeat(501);
  assert.match(gateField("summary", { value: "ok", quote: big }, big, null).reason, /quote longer/);
});

test("gateExtraction: accepted + rejected, skips nulls", () => {
  const out = gateExtraction(
    {
      id: "a",
      fields: {
        price_text: { value: "£20 for two", quote: "just £20 for two", url: null },
        includes: { value: "Free wine", quote: "free wine", url: null },
        summary: { value: null, quote: null, url: null },
      },
    },
    page
  );
  assert.deepEqual(Object.keys(out.accepted), ["price_text"]);
  assert.equal(out.rejected.includes.reason, "quote not found in page text");
  assert.equal("summary" in out.accepted || "summary" in out.rejected, false);
});

test("gateExtraction: blocked or missing page rejects everything", () => {
  const ex = { id: "a", fields: { price_text: { value: "£1", quote: "£1", url: null } } };
  assert.equal(gateExtraction(ex, { status: "blocked", text: null }).rejected.price_text.reason, "page blocked");
  assert.equal(gateExtraction(ex, null).rejected.price_text.reason, "no saved page");
});
