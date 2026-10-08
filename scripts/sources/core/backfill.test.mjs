import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPageImage, extractEventJsonLdFields, triedRecently } from "./backfill.mjs";
import { partitionByGuardedColumns } from "./upsert.mjs";

test("extractPageImage: og:image wins, relative URLs resolve against the page, either attribute order", () => {
  const html = `<head><meta property="og:image" content="/img/poster.jpg"></head>`;
  assert.equal(extractPageImage(html, "https://venue.example/events/1"), "https://venue.example/img/poster.jpg");
  const html2 = `<meta content="https://cdn.example/a.jpg?x=1&amp;y=2" property="og:image">`;
  assert.equal(extractPageImage(html2, "https://venue.example/e"), "https://cdn.example/a.jpg?x=1&y=2");
});

test("extractPageImage: falls back to the JSON-LD Event image, then twitter:image", () => {
  assert.equal(extractPageImage("<head></head>", "https://v.example/e", "https://cdn.example/ld.jpg"), "https://cdn.example/ld.jpg");
  assert.equal(extractPageImage(`<meta name="twitter:image" content="https://cdn.example/t.jpg">`, "https://v.example/e"), "https://cdn.example/t.jpg");
  assert.equal(extractPageImage("<head></head>", "https://v.example/e"), null);
});

test("extractPageImage: generic site logos and non-http values are rejected", () => {
  assert.equal(extractPageImage(`<meta property="og:image" content="https://v.example/assets/logo.png">`, "https://v.example/e"), null);
  assert.equal(extractPageImage(`<meta property="og:image" content="https://v.example/default-share.jpg">`, "https://v.example/e"), null);
  assert.equal(extractPageImage(`<meta property="og:image" content="javascript:alert(1)">`, "https://v.example/e"), null);
  assert.equal(extractPageImage(`<meta property="og:image" content="data:image/png;base64,AAAA">`, "https://v.example/e"), null);
  // a poster whose name merely contains a banned word as part of a longer word is fine
  assert.equal(extractPageImage(`<meta property="og:image" content="https://v.example/blogo-night.jpg">`, "https://v.example/e"), "https://v.example/blogo-night.jpg");
});

test("extractEventJsonLdFields returns the Event image", () => {
  const html = `<script type="application/ld+json">{"@type":"Event","name":"X","startDate":"2026-10-10","image":["https://c.example/e.jpg"]}</script>`;
  assert.equal(extractEventJsonLdFields(html).image, "https://c.example/e.jpg");
});

test("triedRecently: within 14 days only", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  assert.equal(triedRecently("2026-10-01T12:00:00Z", now), true);
  assert.equal(triedRecently("2026-09-20T12:00:00Z", now), false);
  assert.equal(triedRecently(null, now), false);
  assert.equal(triedRecently("garbage", now), false);
});

test("partitionByGuardedColumns: null image_url / place_id / enriched_at are omitted, never sent as null", () => {
  const rows = [
    { provider: "a", provider_event_id: "1", image_url: "https://i", place_id: null, enriched_at: null },
    { provider: "a", provider_event_id: "2", image_url: null, place_id: "p", enriched_at: null },
    { provider: "a", provider_event_id: "3", image_url: null, place_id: null, enriched_at: null },
    { provider: "a", provider_event_id: "4", image_url: "https://j", place_id: null, enriched_at: "2026-10-08T00:00:00Z" },
    { provider: "a", provider_event_id: "5", image_url: "https://k", place_id: null, enriched_at: null },
  ];
  const { batches } = partitionByGuardedColumns(rows);
  assert.equal(batches.length, 4);
  for (const b of batches) {
    const keys = new Set(b.rows.map((r) => Object.keys(r).sort().join(",")));
    assert.equal(keys.size, 1, `uniform keys in ${b.label}`);
    for (const r of b.rows) for (const v of Object.values(r)) assert.notEqual(v, null);
  }
  assert.equal(batches.find((b) => b.label === "plain").rows.length, 1);
  assert.equal(batches.find((b) => b.label === "with image_url").rows.length, 2);
});
