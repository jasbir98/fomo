// Run with `node --test --experimental-strip-types lib/auth/safe-next.test.ts`
// once the repo's Node version supports type-stripping (v22.6+); until then,
// `npx tsx --test lib/auth/safe-next.test.ts` runs it just as well.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeNext } from "./safe-next";

const REJECTED_TO_ROOT: Array<[string]> = [
  ["/%09/evil.com"],
  ["/%0a/evil.com"],
  ["/%0d/evil.com"],
  ["/\t/evil.com"],
  ["/\\evil.com"],
  ["//evil.com"],
  ["https://evil.com"],
  ["javascript:alert(1)"],
  ["/%2F/evil.com"],
  ["/%5C/evil.com"],
  [""],
];

for (const [input] of REJECTED_TO_ROOT) {
  test(`safeNext(${JSON.stringify(input)}) falls back to "/"`, () => {
    assert.equal(safeNext(input), "/");
  });
}

test('safeNext(null) falls back to "/"', () => {
  assert.equal(safeNext(null), "/");
});

test('safeNext(undefined) falls back to "/"', () => {
  assert.equal(safeNext(undefined), "/");
});

test("safeNext keeps a valid path with a query string", () => {
  assert.equal(safeNext("/ok?a=1"), "/ok?a=1");
});

test("safeNext keeps a valid path with a hash", () => {
  assert.equal(safeNext("/happening/abc#x"), "/happening/abc#x");
});

test("safeNext keeps a valid path with tracking params", () => {
  assert.equal(safeNext("/weekend?utm_source=dm"), "/weekend?utm_source=dm");
});
