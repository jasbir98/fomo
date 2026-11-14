// Run with `npx tsx --test lib/blocked-language.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedLanguagesFromEnv, isBlockedLanguage } from "./blocked-language";

const BLOCKED = [
  "zh-CN",
  "zh-cn",
  "zh_CN",
  " zh-CN ",
  "en-GB,zh-CN;q=0.8",
  "en-GB, zh-CN ; q=0.8",
  "zh-CN,zh;q=0.9,en;q=0.8",
];
const ALLOWED: Array<string | null> = [
  "zh-CN;q=0",
  "zh-CN;q=0.0",
  "zh-TW",
  "zh-HK",
  "zh",
  "en-CN",
  "en-GB",
  "en-GB,en;q=0.9",
  "*",
  "",
  null,
  ";;;,,,;q=",
  "zh-CN;q=abc",
  "\u0000￿ garbage",
];

for (const h of BLOCKED) test(`blocks ${JSON.stringify(h)}`, () => assert.equal(isBlockedLanguage(h), true));
for (const h of ALLOWED) test(`allows ${JSON.stringify(h)}`, () => assert.equal(isBlockedLanguage(h), false));

test("env unset uses default", () => assert.deepEqual(blockedLanguagesFromEnv({}), ["zh-CN"]));
test("env empty disables blocking", () => {
  const list = blockedLanguagesFromEnv({ BLOCKED_LANGUAGES: "" });
  assert.deepEqual(list, []);
  assert.equal(isBlockedLanguage("zh-CN", list), false);
});
test("env zh-CN,ru blocks ru", () => {
  const list = blockedLanguagesFromEnv({ BLOCKED_LANGUAGES: "zh-CN, ru" });
  assert.equal(isBlockedLanguage("ru", list), true);
  assert.equal(isBlockedLanguage("ru-RU", list), false);
  assert.equal(isBlockedLanguage("zh-CN", list), true);
  assert.equal(isBlockedLanguage("en-GB", list), false);
});
