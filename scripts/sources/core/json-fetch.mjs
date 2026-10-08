/**
 * Polite JSON GET for public API endpoints (e.g. WordPress REST): same
 * robots.txt check, per-host rate limit and timeout as politeFetch, but no
 * HTML-challenge heuristics (a short JSON body is not an interstitial).
 * Returns { ok, status, data } or { ok:false, reason, status? }. Never throws.
 */

import { USER_AGENT, REQUEST_TIMEOUT_MS, PER_HOST_INTERVAL_MS, getRobots, isAllowedByGroup, waitForHostSlot } from "./fetch.mjs";

export async function politeJson(url) {
  try {
    const u = new URL(url);
    const robots = await getRobots(url);
    if (robots.failClosed) return { ok: false, reason: "robots_unavailable" };
    if (!isAllowedByGroup(robots.group, u.pathname + u.search)) return { ok: false, reason: "robots_disallowed" };
    const interval =
      robots.crawlDelay != null && robots.crawlDelay * 1000 > PER_HOST_INTERVAL_MS ? robots.crawlDelay * 1000 : PER_HOST_INTERVAL_MS;
    await waitForHostSlot(u.hostname, interval);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: controller.signal });
      if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
      try {
        return { ok: true, status: res.status, data: await res.json() };
      } catch {
        return { ok: false, status: res.status, reason: "invalid JSON" };
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return { ok: false, reason: err?.name === "AbortError" ? "timed out" : `network error: ${err.message}` };
  }
}
