#!/usr/bin/env node
/**
 * place-og-images.mjs — gives curated Edinburgh places with no photo the
 * share image (og:image) from their own website: the picture a venue picks
 * for its link previews, usually its frontage or room. Free, unlike Google
 * Place Photos, which this project doesn't use (docs/daily-sources.md).
 *
 * For each place with a website and no photo (no image_url, no place_photos):
 *   1. fetch the homepage politely (robots.txt, per-host rate limit —
 *      scripts/sources/core/fetch.mjs);
 *   2. take og:image / twitter:image (extractPageImage, the same rules the
 *      daily events ingest uses, which already drop logo/placeholder paths);
 *   3. download it and keep it only if it looks like a photo, not a logo:
 *      JPEG/PNG/WebP, at least 600x300, a sane shape (scripts/lib/image-probe.mjs).
 *
 *   4. when ANTHROPIC_API_KEY is set, ask Claude Haiku 5.5 to look at each
 *      one: a photo of the venue, its food/drink or its room is kept; a
 *      logo, text graphic, stock photo, screenshot or poster is marked
 *      `keep: false` (scripts/lib/photo-review.mjs).
 *
 * DRY RUN is the DEFAULT. It writes scraper/out/place-og-images-<date>/:
 *   proposals.json  one numbered entry per photo found, with Haiku's verdict
 *   review.html     a numbered contact sheet, Haiku's rejects shown greyed
 * Then apply. Haiku's rejects are left out unless named in --include;
 * --skip leaves out more:
 *   node --env-file=.env.local scripts/place-og-images.mjs --apply \
 *     --from-proposals scraper/out/place-og-images-<date>/proposals.json --skip 3,17 --include 22
 *
 * No API key? Have a reviewer (a person, or a Claude Code subagent) write
 * [{n, verdict, reason}] with the verdicts in scripts/lib/photo-review.mjs,
 * then merge them into the proposals and redraw the contact sheet:
 *   node --env-file=.env.local scripts/place-og-images.mjs \
 *     --from-proposals <dir>/proposals.json --verdicts verdicts.json
 *
 * --apply inserts into `place_photos` (provider "og-image", credit = the
 * site's host, source_url = the website), never touching `places.image_url`.
 * Undo everything with: delete from place_photos where provider = 'og-image';
 * Places that got a photo since the dry run are skipped. Never deletes.
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 * ANTHROPIC_API_KEY is optional (no key: every photo goes to manual review).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EDINBURGH_PLACES_QUERY } from "./lib/place-match.mjs";
import { imageSize, photoRejection } from "./lib/image-probe.mjs";
import { KEEP_VERDICTS, VERDICTS, reviewPhoto } from "./lib/photo-review.mjs";
import { extractPageImage } from "./sources/core/backfill.mjs";
import { USER_AGENT, politeFetch } from "./sources/core/fetch.mjs";

function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const APPLY = process.argv.includes("--apply");
const FROM = argValue("from-proposals");
const numberList = (v) => new Set((v ?? "").split(",").map((s) => Number(s.trim())).filter(Boolean));
const SKIP = numberList(argValue("skip"));
const INCLUDE = numberList(argValue("include"));
const LIMIT = Number(argValue("limit")) || Infinity;
const VERDICTS_FILE = argValue("verdicts");

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!supabaseUrl || !serviceRoleKey) {
  console.error("[place-og-images] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Run with --env-file=.env.local.");
  process.exit(1);
}
if (APPLY && !FROM) {
  console.error("[place-og-images] --apply needs --from-proposals <file> from a reviewed dry run.");
  process.exit(1);
}

const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" };

async function rest(path, options = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Social and listing pages share their own branding, not the venue.
const NOT_A_VENUE_SITE = /(^|\.)(facebook|instagram|linktr|tripadvisor|google|wixsite|twitter|x|tiktok)\.(com|ee|co\.uk)$/i;
const IMAGE_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 8_000_000;
const CONCURRENCY = 6;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function fetchImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "image/*" }, signal: controller.signal });
    if (!res.ok) return { error: `image HTTP ${res.status}` };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return { error: "image over 8MB" };
    return { bytes: buf };
  } catch (err) {
    return { error: err?.name === "AbortError" ? "image timed out" : `image ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function findPhoto(place) {
  let site;
  try {
    site = new URL(/^https?:\/\//i.test(place.website) ? place.website : `https://${place.website}`);
  } catch {
    return { status: "skip", reason: "bad website URL" };
  }
  if (NOT_A_VENUE_SITE.test(site.hostname)) return { status: "skip", reason: `social/listing site (${site.hostname})` };
  const page = await politeFetch(site.toString());
  if (!page.ok) return { status: "fail", reason: page.reason };
  const found = extractPageImage(page.html, page.finalUrl);
  if (!found) return { status: "fail", reason: "no og:image" };
  // Browsers on an https page won't load an http image, so prefer https.
  let image = found.replace(/^http:\/\//i, "https://");
  let got = await fetchImage(image);
  if (got.error && image !== found) {
    image = found;
    got = await fetchImage(found);
  }
  if (got.error) return { status: "fail", reason: got.error };
  const size = imageSize(got.bytes);
  const rejection = photoRejection(size, got.bytes.length);
  if (rejection) return { status: "fail", reason: rejection, image };
  return { status: "found", image, bytes: got.bytes, mediaType: `image/${size.type}`, width: size.width, height: size.height, credit: hostOf(page.finalUrl) ?? site.hostname };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function reviewHtml(proposals) {
  const cards = proposals
    .map(
      (p) => `<figure class="${p.keep === false ? "no" : ""}"><img referrerpolicy="no-referrer" src="${esc(p.image)}" loading="lazy" alt=""><figcaption><b>${p.n}.</b> ${esc(p.name)}<br><span>${esc(p.category)} · ${esc(p.credit)} · ${p.width}×${p.height}</span>${p.verdict ? `<br><i>${p.keep === false ? "✗" : "✓"} ${esc(p.verdict)}: ${esc(p.reason)}</i>` : ""}</figcaption></figure>`
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Place photos review</title>
<style>body{font:14px system-ui;margin:16px;background:#f6f6f6}h1{font-size:18px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
figure{margin:0;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px #0002}
img{width:100%;aspect-ratio:16/10;object-fit:cover;display:block;background:#ddd}
figcaption{padding:8px}span{color:#666;font-size:12px}i{font-size:12px}
figure.no{opacity:.45}figure.no i{color:#b91c1c}</style>
<h1>${proposals.length} proposed place photos — ${proposals.filter((p) => p.keep !== false).length} kept, greyed ones rejected by Haiku. Note the numbers of any that look wrong.</h1><main>${cards}</main>`;
}

async function dryRun() {
  const rows = await rest(`${EDINBURGH_PLACES_QUERY.replace("select=id,name,image_url,lat,lng,place_photos(url,display_order)", "select=id,name,category,website,image_url,place_photos(url)")}&website=not.is.null&image_url=is.null&order=name.asc&limit=2000`);
  const todo = rows.filter((r) => !(r.place_photos?.length)).slice(0, LIMIT);
  console.log(`[place-og-images] ${todo.length} place(s) with a website and no photo.`);

  let done = 0;
  const results = await mapLimit(todo, CONCURRENCY, async (place) => {
    const r = await findPhoto(place).catch((err) => ({ status: "fail", reason: err.message }));
    done += 1;
    if (done % 20 === 0) console.log(`  ${done}/${todo.length}`);
    return { place, ...r };
  });

  const found = results.filter((r) => r.status === "found");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && found.length > 0) {
    console.log(`\n[place-og-images] reviewing ${found.length} photo(s) with Claude Haiku 5.5…`);
    await mapLimit(found, 4, async (r) => {
      try {
        Object.assign(r, await reviewPhoto({ bytes: r.bytes, mediaType: r.mediaType, url: r.image, name: r.place.name, category: r.place.category }));
      } catch (err) {
        console.error(`  review failed for ${r.place.name}: ${err.message}`);
      }
    });
  } else if (!apiKey) {
    console.log("\n[place-og-images] no ANTHROPIC_API_KEY: skipping the Haiku review, check every photo by eye.");
  }
  const proposals = found.map((r, i) => ({
    n: i + 1,
    place_id: r.place.id,
    name: r.place.name,
    category: r.place.category,
    website: r.place.website,
    image: r.image,
    width: r.width,
    height: r.height,
    credit: r.credit,
    verdict: r.verdict ?? null,
    keep: r.keep ?? null,
    reason: r.reason ?? null,
  }));
  const dir = join("scraper", "out", `place-og-images-${new Date().toISOString().slice(0, 10)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposals.json"), JSON.stringify(proposals, null, 2));
  writeFileSync(join(dir, "review.html"), reviewHtml(proposals));

  const reasons = {};
  for (const r of results) if (r.status !== "found") reasons[r.reason.replace(/\(.*\)/, "").trim()] = (reasons[r.reason.replace(/\(.*\)/, "").trim()] ?? 0) + 1;
  const rejected = proposals.filter((p) => p.keep === false).length;
  console.log(`\nFOUND ${found.length} / ${todo.length}${rejected ? ` (Haiku rejected ${rejected})` : ""}. Not found, by reason:`);
  for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${reason}`);
  console.log(`\nReview: ${join(dir, "review.html")}\nThen: --apply --from-proposals ${join(dir, "proposals.json")} --skip <numbers> --include <numbers>`);
}

async function apply() {
  const all = JSON.parse(readFileSync(FROM, "utf8"));
  const proposals = all.filter((p) => !SKIP.has(p.n) && (p.keep !== false || INCLUDE.has(p.n)));
  console.log(`[place-og-images] applying ${proposals.length} of ${all.length} photo(s).`);
  let ok = 0;
  let already = 0;
  let failed = 0;
  for (const p of proposals) {
    try {
      const [place] = await rest(`places?id=eq.${p.place_id}&select=image_url,place_photos(url)`);
      if (!place || place.image_url || place.place_photos?.length) {
        already += 1;
        continue;
      }
      await rest("place_photos", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          place_id: p.place_id,
          url: p.image,
          credit: p.credit,
          license: "Venue's own share image",
          source_url: p.website,
          display_order: 0,
          provider: "og-image",
          is_exact_place: true,
          width: p.width,
          height: p.height,
        }),
      });
      ok += 1;
    } catch (err) {
      failed += 1;
      console.error(`[place-og-images] FAILED ${p.n}. ${p.name}: ${err.message}`);
    }
  }
  console.log(`[place-og-images] done: written=${ok} already-had-photo=${already} failed=${failed}`);
}

function mergeVerdicts() {
  const proposals = JSON.parse(readFileSync(FROM, "utf8"));
  const byN = new Map(JSON.parse(readFileSync(VERDICTS_FILE, "utf8")).map((v) => [v.n, v]));
  let merged = 0;
  for (const p of proposals) {
    const v = byN.get(p.n);
    if (!v || !VERDICTS.includes(v.verdict)) continue;
    Object.assign(p, { verdict: v.verdict, keep: KEEP_VERDICTS.has(v.verdict), reason: v.reason ?? null });
    merged += 1;
  }
  writeFileSync(FROM, JSON.stringify(proposals, null, 2));
  writeFileSync(join(dirname(FROM), "review.html"), reviewHtml(proposals));
  const kept = proposals.filter((p) => p.keep !== false).length;
  console.log(`[place-og-images] merged ${merged} verdict(s): ${kept} kept, ${proposals.length - kept} rejected. Review: ${join(dirname(FROM), "review.html")}`);
}

(APPLY ? apply() : FROM && VERDICTS_FILE ? Promise.resolve(mergeVerdicts()) : dryRun()).catch((err) => {
  console.error("[place-og-images] fatal:", err);
  process.exit(1);
});
