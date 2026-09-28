// Run with `node --test --experimental-strip-types lib/http/safe-url.test.ts`
// once the repo's Node version supports type-stripping (v22.6+); until then,
// `npx tsx --test lib/http/safe-url.test.ts` runs it just as well.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeHttpUrl } from "./safe-url";

test("safeHttpUrl keeps a valid https URL", () => {
  assert.equal(safeHttpUrl("https://example.com/tickets"), "https://example.com/tickets");
});

test("safeHttpUrl keeps a valid http URL", () => {
  assert.equal(safeHttpUrl("http://example.com"), "http://example.com");
});

test("safeHttpUrl trims surrounding whitespace", () => {
  assert.equal(safeHttpUrl("  https://example.com  "), "https://example.com");
});

const REJECTED: Array<[string, unknown]> = [
  ["javascript: URL", "javascript:alert(1)"],
  ["uppercase javascript: URL with leading space", " JAVASCRIPT:alert(1)"],
  ["data: URL", "data:text/html,<script>alert(1)</script>"],
  ["vbscript: URL", "vbscript:msgbox(1)"],
  ["relative path", "/foo"],
  ["empty string", ""],
  ["whitespace-only string", "   "],
  ["null", null],
  ["undefined", undefined],
  ["number", 123],
  ["garbage string", "not a url"],
  ["mailto: URL", "mailto:test@example.com"],
];

for (const [label, input] of REJECTED) {
  test(`safeHttpUrl rejects ${label}`, () => {
    assert.equal(safeHttpUrl(input), null);
  });
}
