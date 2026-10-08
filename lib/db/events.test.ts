// Run: npx tsx --test lib/db/events.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnknownStatusColumn } from "./events";

test("isUnknownStatusColumn: only a missing events.status column triggers the retry", () => {
  assert.equal(isUnknownStatusColumn({ code: "42703", message: "column events.status does not exist" }), true);
  assert.equal(isUnknownStatusColumn({ code: "PGRST204", message: "Could not find the 'status' column of 'events' in the schema cache" }), true);
  assert.equal(isUnknownStatusColumn({ code: "42703", message: "column events.category does not exist" }), false);
  assert.equal(isUnknownStatusColumn({ code: "57014", message: "canceling statement due to statement timeout" }), false);
  assert.equal(isUnknownStatusColumn(null), false);
});
