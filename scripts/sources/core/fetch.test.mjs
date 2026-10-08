import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOT_TOKEN,
  isAllowedByGroup,
  looksLikeChallengePage,
  parseRobotsTxt,
  robotsPatternToRegex,
  selectRobotsGroup,
} from "./fetch.mjs";

const allowed = (robotsTxt, path) => isAllowedByGroup(selectRobotsGroup(parseRobotsTxt(robotsTxt), BOT_TOKEN), path);

test("robots: no rules / empty Disallow allows everything", () => {
  assert.equal(allowed("", "/anything"), true);
  assert.equal(allowed("User-agent: *\nDisallow:", "/anything"), true);
});

test("robots: wildcard group Disallow blocks the path prefix, not siblings", () => {
  const txt = "User-agent: *\nDisallow: /admin\n";
  assert.equal(allowed(txt, "/admin/users"), false);
  assert.equal(allowed(txt, "/events/1"), true);
});

test("robots: longest match wins, ties go to Allow", () => {
  const txt = "User-agent: *\nDisallow: /events/\nAllow: /events/public\n";
  assert.equal(allowed(txt, "/events/private"), false);
  assert.equal(allowed(txt, "/events/public/1"), true);
  const tie = "User-agent: *\nDisallow: /a\nAllow: /a\n";
  assert.equal(allowed(tie, "/a"), true);
});

test("robots: a group naming our product token beats the * group", () => {
  const txt = "User-agent: *\nDisallow: /\n\nUser-agent: FomoEdinburghBot\nAllow: /\n";
  assert.equal(allowed(txt, "/d/edinburgh"), true);
  // Another bot's named group doesn't apply to us; * does.
  const other = "User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n";
  assert.equal(allowed(other, "/d/edinburgh"), false);
});

test("robots: * and $ wildcards", () => {
  assert.ok(robotsPatternToRegex("/*.json$").test("/data/x.json"));
  assert.ok(!robotsPatternToRegex("/*.json$").test("/data/x.json?y=1"));
  assert.ok(robotsPatternToRegex("/search*").test("/search?q=1"));
  const txt = "User-agent: *\nDisallow: /*?page=\n";
  assert.equal(allowed(txt, "/d/edinburgh?page=2"), false);
  assert.equal(allowed(txt, "/d/edinburgh"), true);
});

test("robots: Crawl-delay is parsed onto the group; comments and unknown fields ignored", () => {
  const groups = parseRobotsTxt("# hi\nUser-agent: *\nCrawl-delay: 5 # slow\nSitemap: https://x/sitemap.xml\nDisallow: /x\n");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].crawlDelay, 5);
  assert.equal(groups[0].rules.length, 1);
});

test("looksLikeChallengePage: markers and tiny bodies are flagged, normal pages are not", () => {
  const pad = "x".repeat(6000);
  assert.equal(looksLikeChallengePage(`<html>Just a moment...${pad}</html>`), true);
  assert.equal(looksLikeChallengePage("<html>tiny</html>"), true);
  assert.equal(looksLikeChallengePage(`<html><script src="https://cdn.cloudflare.com/x.js"></script>${pad}</html>`), false);
});
