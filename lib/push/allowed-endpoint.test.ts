// Run with `node --test --experimental-strip-types lib/push/allowed-endpoint.test.ts`
// once the repo's Node version supports type-stripping (v22.6+); until then,
// `npx tsx --test lib/push/allowed-endpoint.test.ts` runs it just as well.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedPushEndpoint } from "./allowed-endpoint";

const ACCEPTED: Array<[string, string]> = [
  ["FCM", "https://fcm.googleapis.com/fcm/send/abc123"],
  ["Mozilla autopush", "https://updates.push.services.mozilla.com/wpush/v2/abc123"],
  ["Mozilla autopush, deeper subdomain", "https://foo.updates.push.services.mozilla.com/wpush/v2/abc123"],
  ["WNS", "https://bn1.notify.windows.com/?token=abc123"],
  ["Safari (bare host)", "https://web.push.apple.com/abc123"],
  ["Safari (subdomain)", "https://foo.push.apple.com/abc123"],
];

for (const [label, input] of ACCEPTED) {
  test(`isAllowedPushEndpoint accepts ${label}`, () => {
    assert.equal(isAllowedPushEndpoint(input), true);
  });
}

const REJECTED: Array<[string, unknown]> = [
  ["http (not https) on an otherwise-allowed host", "http://fcm.googleapis.com/fcm/send/abc123"],
  ["unrelated host", "https://evil.example.com/steal"],
  ["look-alike host missing the subdomain dot", "https://evilpush.apple.com/abc123"],
  ["host with allowed suffix as a path, not the host", "https://evil.com/fcm.googleapis.com"],
  ["allowed host used as a subdomain of an attacker domain", "https://fcm.googleapis.com.evil.com/steal"],
  ["internal/metadata-style host", "https://169.254.169.254/latest/meta-data/"],
  ["localhost", "https://localhost:1234/endpoint"],
  ["javascript: URL", "javascript:alert(1)"],
  ["relative path", "/foo"],
  ["empty string", ""],
  ["null", null],
  ["undefined", undefined],
  ["number", 123],
  ["garbage string", "not a url"],
];

for (const [label, input] of REJECTED) {
  test(`isAllowedPushEndpoint rejects ${label}`, () => {
    assert.equal(isAllowedPushEndpoint(input), false);
  });
}
