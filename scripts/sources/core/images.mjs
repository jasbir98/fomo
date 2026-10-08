/**
 * Image check: HEAD the image_url of rows that are new to the DB (or whose
 * image changed). A non-2xx or non-image response sets image_url to null so the
 * app's fallback image is used. Read-only, so it runs in dry runs too.
 *
 * At most MAX_IMAGE_CHECKS (300) URLs per run; polite per-host spacing via the
 * shared host slot (core/fetch.mjs). Results are cached per URL for the run.
 */

import { USER_AGENT, waitForHostSlot } from "./fetch.mjs";
import { hasSupabase, restGetAll } from "./rest.mjs";

export const MAX_IMAGE_CHECKS = 300;
export const IMAGE_TIMEOUT_MS = 8_000;
// Image CDNs, not page crawls: a lighter per-host interval than the 1s used for HTML pages.
export const IMAGE_HOST_INTERVAL_MS = 250;

/**
 * Existing upcoming rows for the given providers: Map "provider|id" -> image_url (or null).
 * Returns null when the DB is unreachable / not configured (callers then treat every row as new).
 */
export async function fetchExistingRows(providers, now = new Date()) {
  if (!hasSupabase() || providers.length === 0) return null;
  const list = providers.map((p) => `"${String(p).replace(/"/g, "")}"`).join(",");
  const path =
    `events?select=provider,provider_event_id,image_url` +
    `&provider=in.(${encodeURIComponent(list)})` +
    `&starts_at=gte.${encodeURIComponent(now.toISOString())}` +
    `&order=id.asc`;
  const res = await restGetAll(path);
  if (!res.ok) {
    console.warn(`[daily-sources] existing-rows lookup failed (${res.status}): ${JSON.stringify(res.error)} — treating every row as new for the image check`);
    return null;
  }
  const map = new Map();
  for (const r of res.rows) map.set(`${r.provider}|${r.provider_event_id}`, r.image_url ?? null);
  return map;
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|svg|bmp|ico)(\?|#|$)/i;

/** True when the first bytes look like JPEG / PNG / GIF / WebP / AVIF / SVG. */
export function bytesLookLikeImage(bytes) {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true; // GIF
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return true;
  if (b.length >= 12 && ascii(4, 8) === "ftyp" && /^(avif|avis|heic|heix|mif1)/.test(ascii(8, 12))) return true;
  if (b.length >= 5 && /^\s*<(\?xml|svg)/i.test(ascii(0, Math.min(b.length, 64)))) return true;
  return false;
}

async function sniffIsImage(url, attempt) {
  try {
    const res = await attempt("GET");
    if (!(res.status >= 200 && res.status < 300) || !res.body) return false;
    const reader = res.body.getReader();
    const { value } = await reader.read();
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    return value ? bytesLookLikeImage(value.slice(0, 64)) : false;
  } catch {
    return false;
  }
}

/**
 * HEAD (fallback: GET with Range bytes=0-63 on 405/501). Returns { ok, reason }:
 * ok when 2xx and the content-type is image/*. A 2xx with NO content-type (some
 * CDNs omit it on HEAD) or a generic application/octet-stream is accepted when
 * the URL itself ends in an image extension.
 */
export async function probeImage(url, fetchImpl = fetch) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  const attempt = async (method) => {
    await waitForHostSlot(host, IMAGE_HOST_INTERVAL_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
    try {
      const headers = { "User-Agent": USER_AGENT, Accept: "image/*,*/*;q=0.5" };
      if (method === "GET") headers.Range = "bytes=0-63";
      return await fetchImpl(url, { method, headers, signal: controller.signal, redirect: "follow" });
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let res = await attempt("HEAD");
    if (res.status === 405 || res.status === 501) {
      res = await attempt("GET");
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
    }
    if (!(res.status >= 200 && res.status < 300)) return { ok: false, reason: `http_${res.status}` };
    const type = (res.headers.get("content-type") ?? "").toLowerCase().split(";")[0].trim();
    if (type.startsWith("image/")) return { ok: true };
    if (type === "" || type === "application/octet-stream" || type === "binary/octet-stream") {
      // Some CDNs serve real images with no / a generic content-type: sniff the first bytes.
      if (IMAGE_EXT_RE.test(url)) return { ok: true };
      const sniffed = await sniffIsImage(url, attempt);
      return sniffed ? { ok: true } : { ok: false, reason: `content_type_${type || "none"}` };
    }
    return { ok: false, reason: `content_type_${type}` };
  } catch (err) {
    return { ok: false, reason: err?.name === "AbortError" ? "timeout" : "network_error" };
  }
}

export async function imageLooksOk(url, fetchImpl = fetch) {
  return (await probeImage(url, fetchImpl)).ok;
}

/**
 * Check images on `rows` (mutated in place: broken image_url -> null).
 * `existing` is fetchExistingRows()'s map (null = treat all as new).
 * Returns { checked, broken, skippedExisting, overCap, perProvider: {provider: brokenCount} }.
 */
export async function checkImages(rows, existing, { maxChecks = MAX_IMAGE_CHECKS, check = probeImage } = {}) {
  const result = { checked: 0, broken: 0, skippedExisting: 0, overCap: 0, perProvider: {}, reasons: {} };
  const cache = new Map(); // url -> boolean
  for (const row of rows) {
    const url = row.image_url;
    if (!url) continue;
    if (existing && existing.has(`${row.provider}|${row.provider_event_id}`) && existing.get(`${row.provider}|${row.provider_event_id}`) === url) {
      result.skippedExisting += 1;
      continue;
    }
    let ok = cache.get(url);
    if (ok === undefined) {
      if (result.checked >= maxChecks) {
        result.overCap += 1;
        continue;
      }
      result.checked += 1;
      const outcome = await check(url);
      ok = typeof outcome === "boolean" ? outcome : outcome.ok;
      if (!ok && typeof outcome === "object") result.reasons[outcome.reason ?? "unknown"] = (result.reasons[outcome.reason ?? "unknown"] ?? 0) + 1;
      cache.set(url, ok);
    }
    if (!ok) {
      row.image_url = null;
      result.broken += 1;
      result.perProvider[row.provider] = (result.perProvider[row.provider] ?? 0) + 1;
    }
  }
  return result;
}
