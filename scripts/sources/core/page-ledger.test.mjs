import { test } from "node:test";
import assert from "node:assert/strict";
import { hashText, isUnchanged, recordPages, reemitRow, ROW_COLUMNS } from "./page-ledger.mjs";

test("hashText is a stable sha256 hex", () => {
  assert.equal(hashText("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(hashText("a"), hashText("a"));
  assert.notEqual(hashText("a"), hashText("b"));
});

test("isUnchanged is false for pages the ledger has never seen (also when the table is missing)", () => {
  assert.equal(isUnchanged("https://example.com/never-seen", hashText("x")), false);
});

test("recordPages is a no-op unless write is true", async () => {
  assert.deepEqual(await recordPages([{ url: "u", source_id: "s", content_hash: "h", status: 200 }], { write: false }), { ok: 0, failed: 0 });
});

test("reemitRow keeps only standard row columns and refreshes fetched_at", () => {
  const now = new Date("2026-10-08T10:00:00Z");
  const stored = { id: "uuid", created_at: "x", provider: "p", provider_event_id: "e", name: "n", starts_at: "2026-10-10T00:00:00Z", fetched_at: "2026-09-01T00:00:00Z", extra: 1 };
  const row = reemitRow(stored, now);
  assert.equal(row.fetched_at, now.toISOString());
  assert.equal(row.name, "n");
  assert.equal(row.description, null);
  assert.deepEqual(Object.keys(row).sort(), [...ROW_COLUMNS].sort());
});
