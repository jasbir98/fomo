import { test } from "node:test";
import assert from "node:assert/strict";
import { occurrenceIsPastLocalHours } from "./local-hours";

const EDINBURGH_TZ = "Europe/London";
const MARKET_HOURS = "Every Saturday 9am–2pm";

test("a happening remains eligible before its local closing time", () => {
  // 12:59 UTC is 13:59 in Edinburgh on this October date.
  assert.equal(
    occurrenceIsPastLocalHours(MARKET_HOURS, "2026-10-10", new Date("2026-10-10T12:59:00Z"), EDINBURGH_TZ),
    false
  );
});

test("a happening is past its local hours at the closing boundary", () => {
  // 13:00 UTC is 14:00 in Edinburgh while British Summer Time is in effect.
  assert.equal(
    occurrenceIsPastLocalHours(MARKET_HOURS, "2026-10-10", new Date("2026-10-10T13:00:00Z"), EDINBURGH_TZ),
    true
  );
});

test("future occurrences and unparseable schedules are not treated as closed", () => {
  assert.equal(
    occurrenceIsPastLocalHours(MARKET_HOURS, "2026-10-17", new Date("2026-10-10T14:00:00Z"), EDINBURGH_TZ),
    false
  );
  assert.equal(
    occurrenceIsPastLocalHours("Every Saturday, all day", "2026-10-10", new Date("2026-10-10T20:00:00Z"), EDINBURGH_TZ),
    false
  );
});