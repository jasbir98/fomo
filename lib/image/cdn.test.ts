// Run with `npx tsx --test lib/image/cdn.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cdnResize } from "./cdn";

const BASE = "https://lh3.googleusercontent.com/a/ACg8ocKabc123";

test("googleusercontent: replaces an account-photo =s96-c segment", () => {
  assert.equal(cdnResize(`${BASE}=s96-c`, { width: 224 }), `${BASE}=w224-h224-c`);
});

test("googleusercontent: replaces a bare =s96 segment", () => {
  assert.equal(cdnResize(`${BASE}=s96`, { width: 224 }), `${BASE}=w224-h224-c`);
});

test("googleusercontent: replaces an existing =w100-h100-c segment", () => {
  assert.equal(cdnResize(`${BASE}=w100-h100-c`, { width: 224 }), `${BASE}=w224-h224-c`);
});

test("googleusercontent: replaces =w100-h100 with multi-flag suffix", () => {
  assert.equal(cdnResize(`${BASE}=w100-h100-p-k-no`, { width: 224 }), `${BASE}=w224-h224-c`);
});

test("googleusercontent: appends when there is no size segment", () => {
  assert.equal(cdnResize(BASE, { width: 224 }), `${BASE}=w224-h224-c`);
});

test("googleusercontent: never produces a doubled size segment", () => {
  const out = cdnResize(`${BASE}=s96-c`, { width: 112 });
  assert.equal(out?.match(/=/g)?.length, 1);
});

test("other hosts are untouched by the googleusercontent rule", () => {
  assert.equal(cdnResize("https://example.com/a.jpg=s96-c", { width: 224 }), null);
});
