import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFansOf } from "./venue-rss.mjs";

test("splitFansOf separates the act from the tagline", () => {
  assert.deepEqual(splitFansOf("The Empty Pagefor fans of.. Sonic Youth, Garbage, PJ Harvey"), {
    name: "The Empty Page",
    fansOf: "Sonic Youth, Garbage, PJ Harvey",
  });
  assert.deepEqual(splitFansOf("Mildred For fans of… MJ Lenderman, Midlake"), { name: "Mildred", fansOf: "MJ Lenderman, Midlake" });
  assert.deepEqual(splitFansOf("Mosh Spice Spice Girls Metal Tribute"), { name: "Mosh Spice Spice Girls Metal Tribute", fansOf: null });
});
