// Run with `npx tsx --test lib/review/analytics-guard.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { NO_ANALYTICS_SCRIPT, isReviewPath } from "./analytics-guard";

test("isReviewPath matches review URLs only", () => {
  assert.equal(isReviewPath("/review/abc.def"), true);
  assert.equal(isReviewPath("https://askfomo.com/review/abc.def?x=1"), true);
  assert.equal(isReviewPath("/deals"), false);
  assert.equal(isReviewPath("/reviews"), false);
  assert.equal(isReviewPath(null), false);
});

test("the inline script queues a beforeSend hook on va and si that drops review URLs only", () => {
  const window: Record<string, unknown> = {};
  vm.runInNewContext(NO_ANALYTICS_SCRIPT, { window, Array });
  for (const name of ["va", "si"]) {
    const queue = window[`${name}q`] as unknown[][];
    assert.equal(queue.length, 1, name);
    assert.equal(queue[0][0], "beforeSend");
    const hook = queue[0][1] as (e: { url: string }) => unknown;
    assert.equal(hook({ url: "https://askfomo.com/review/tok.sig" }), null);
    const ok = { url: "https://askfomo.com/deals" };
    assert.equal(hook(ok), ok);
  }
});

test("the inline script keeps an existing window.va", () => {
  const calls: unknown[][] = [];
  const window: Record<string, unknown> = { va: (...a: unknown[]) => calls.push(a) };
  vm.runInNewContext(NO_ANALYTICS_SCRIPT, { window, Array });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "beforeSend");
});
