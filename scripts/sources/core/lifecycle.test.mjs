import { test } from "node:test";
import assert from "node:assert/strict";
import { healthyProviders, lastLondonDays } from "./retire.mjs";
import { computeHealth, median } from "./health.mjs";
import { bytesLookLikeImage, checkImages, probeImage } from "./images.mjs";
import { buildRunRows } from "./runs.mjs";
import { isMissingSchemaError, totalFromContentRange } from "./rest.mjs";

const NOW = new Date("2026-10-08T12:00:00Z");
const at = (d, h = 6) => `2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:17:00Z`;

test("lastLondonDays: today first, three days", () => {
  assert.deepEqual(lastLondonDays(NOW), ["2026-10-08", "2026-10-07", "2026-10-06"]);
});

test("healthyProviders: needs an ok live kept>0 run on each of the last 3 London days", () => {
  const run = (provider, d, extra = {}) => ({ provider, started_at: at(d), ok: true, kept: 5, status: "live", ...extra });
  const runs = [
    run("a", 6), run("a", 7), run("a", 8),
    run("b", 6), run("b", 8), // missing the 7th
    run("c", 6), run("c", 7), run("c", 8, { kept: 0 }), // empty today
    run("d", 6), run("d", 7), run("d", 8, { status: "shadow" }),
    run("e", 6), run("e", 7), run("e", 8, { ok: false }),
  ];
  assert.deepEqual([...healthyProviders(runs, NOW)], ["a"]);
});

test("healthyProviders: dry run counts today's in-memory result", () => {
  const runs = [
    { provider: "a", started_at: at(6), ok: true, kept: 5, status: "live" },
    { provider: "a", started_at: at(7), ok: true, kept: 5, status: "live" },
  ];
  assert.equal(healthyProviders(runs, NOW).has("a"), false);
  assert.equal(healthyProviders(runs, NOW, { todayHealthy: ["a"] }).has("a"), true);
});

test("median", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("computeHealth: ZERO_TWICE and DROP", () => {
  const h = (provider, d, kept) => ({ provider, started_at: at(d), kept });
  const history = [
    h("zero", 7, 0), h("zero", 6, 10),
    h("drop", 7, 100), h("drop", 6, 90), h("drop", 5, 110),
    h("fine", 7, 100), h("fine", 6, 100),
    h("old", 1, 100), // outside the 7-day window
  ];
  const rows = computeHealth(
    [
      { provider: "zero", kept: 0 },
      { provider: "drop", kept: 30 },
      { provider: "fine", kept: 80 },
      { provider: "new", kept: 0 },
      { provider: "old", kept: 0 },
    ],
    history,
    NOW
  );
  const by = Object.fromEntries(rows.map((r) => [r.provider, r.flags]));
  assert.deepEqual(by.zero, ["ZERO_TWICE", "DROP"]);
  assert.deepEqual(by.drop, ["DROP"]);
  assert.deepEqual(by.fine, []);
  assert.deepEqual(by.new, []); // no history: nothing to compare
  assert.deepEqual(by.old, []); // previous run kept=100 and the 7-day window is empty
});

test("checkImages: skips unchanged-in-db, nulls broken, caches per URL, respects the cap", async () => {
  const calls = [];
  const check = async (url) => {
    calls.push(url);
    return !url.includes("broken");
  };
  const rows = [
    { provider: "p", provider_event_id: "1", image_url: "https://x/same.jpg" },
    { provider: "p", provider_event_id: "2", image_url: "https://x/broken.jpg" },
    { provider: "p", provider_event_id: "3", image_url: "https://x/broken.jpg" },
    { provider: "p", provider_event_id: "4", image_url: "https://x/ok.jpg" },
    { provider: "p", provider_event_id: "5", image_url: null },
  ];
  const existing = new Map([["p|1", "https://x/same.jpg"]]);
  const r = await checkImages(rows, existing, { check });
  assert.deepEqual(calls, ["https://x/broken.jpg", "https://x/ok.jpg"]);
  assert.equal(r.skippedExisting, 1);
  assert.equal(r.broken, 2);
  assert.equal(rows[1].image_url, null);
  assert.equal(rows[2].image_url, null);
  assert.equal(rows[3].image_url, "https://x/ok.jpg");
  assert.deepEqual(r.perProvider, { p: 2 });

  const capped = await checkImages([{ provider: "p", provider_event_id: "a", image_url: "https://x/1" }, { provider: "p", provider_event_id: "b", image_url: "https://x/2" }], null, { check, maxChecks: 1 });
  assert.equal(capped.checked, 1);
  assert.equal(capped.overCap, 1);
});

test("buildRunRows: ok needs a fetch and no error; shadow rows are never inserted/updated; inserted vs updated from the pre-run lookup", () => {
  const started = new Date("2026-10-08T06:17:00Z");
  const rows = buildRunRows({
    runId: "r1",
    startedAt: started,
    perSource: [
      { provider: "a", shadow: false, rows: [{}, {}], stats: { fetched: 2, rejected: { past: 1 } } },
      { provider: "b", shadow: false, rows: [], stats: { fetched: 0 } },
      { provider: "c", shadow: true, rows: [{}], stats: { fetched: 1 } },
      { provider: "d", shadow: false, rows: [], stats: { fetched: 0 }, error: "boom" },
    ],
    upserted: [{ provider: "a", provider_event_id: "1" }, { provider: "a", provider_event_id: "2" }],
    existing: new Map([["a|1", null]]),
  });
  const by = Object.fromEntries(rows.map((r) => [r.provider, r]));
  assert.equal(by.a.ok, true);
  assert.equal(by.a.kept, 2);
  assert.equal(by.a.inserted, 1);
  assert.equal(by.a.updated, 1);
  assert.deepEqual(by.a.rejected, { past: 1 });
  assert.equal(by.b.ok, false);
  assert.equal(by.c.status, "shadow");
  assert.equal(by.c.inserted, 0);
  assert.equal(by.d.ok, false);
  assert.equal(by.d.error, "boom");
});

test("rest helpers", () => {
  assert.equal(isMissingSchemaError({ code: "42703", message: "column events.status does not exist" }), true);
  assert.equal(isMissingSchemaError({ code: "PGRST205", message: "Could not find the table 'public.event_source_runs' in the schema cache" }), true);
  assert.equal(isMissingSchemaError({ code: "23505", message: "duplicate key" }), false);
  assert.equal(totalFromContentRange("0-9/123"), 123);
  assert.equal(totalFromContentRange("*/0"), 0);
  assert.equal(totalFromContentRange("0-9/*"), null);
});

test("healthyProviders: a weekly provider (one run a week) is never healthy, so its rows are never marked gone", () => {
  // Mondays 5 Oct and 12 Oct; 'now' is Thursday 8 Oct. Even with ok, kept>0, live runs.
  const weekly = [
    { provider: "foreveredinburgh", started_at: "2026-09-28T06:17:00Z", ok: true, kept: 40, status: "live" },
    { provider: "foreveredinburgh", started_at: "2026-10-05T06:17:00Z", ok: true, kept: 40, status: "live" },
  ];
  assert.equal(healthyProviders(weekly, NOW).has("foreveredinburgh"), false);
  // Not even on the Monday itself: one healthy day out of three is not enough.
  const monday = new Date("2026-10-05T12:00:00Z");
  assert.equal(healthyProviders(weekly, monday, { todayHealthy: ["foreveredinburgh"] }).has("foreveredinburgh"), false);
});

test("bytesLookLikeImage: magic numbers", () => {
  assert.equal(bytesLookLikeImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), true);
  assert.equal(bytesLookLikeImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d])), true);
  assert.equal(bytesLookLikeImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), true);
  assert.equal(bytesLookLikeImage(new TextEncoder().encode("\0\0\0\x1cftypavif")), true);
  assert.equal(bytesLookLikeImage(new TextEncoder().encode("<!DOCTYPE html><html>")), false);
});

test("probeImage: image/* ok, html not, generic type falls back to byte sniffing, 404 not", async () => {
  const mk = (status, type, body = "") => async () => new Response(body, { status, headers: type ? { "content-type": type } : {} });
  assert.equal((await probeImage("https://img.test/a", mk(200, "image/jpeg"))).ok, true);
  assert.equal((await probeImage("https://img.test/b", mk(200, "text/html"))).ok, false);
  assert.equal((await probeImage("https://img.test/c", mk(404, "image/jpeg"))).ok, false);
  assert.equal((await probeImage("https://img.test/d.png", mk(200, "application/octet-stream"))).ok, true); // extension
  // No extension, no type: sniff. The mock returns a PNG for the GET and a typeless 200 for HEAD.
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  const sniffing = async (_url, init) => (init.method === "HEAD" ? new Response(null, { status: 200 }) : new Response(png, { status: 206 }));
  assert.equal((await probeImage("https://img.test/e", sniffing)).ok, true);
  const htmlBody = async (_url, init) => (init.method === "HEAD" ? new Response(null, { status: 200 }) : new Response("<html>nope</html>", { status: 200 }));
  assert.equal((await probeImage("https://img.test/f", htmlBody)).ok, false);
});
