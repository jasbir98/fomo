/**
 * Description backfill: runs after cross-source merge, on whatever the
 * adapters + cleanDescription didn't already fill.
 */

import { cleanDescription, fallbackDescription, isMidnightUtcSentinel, extractMetaDescription } from "../../lib/describe.mjs";
import { isJunkDescription } from "../../lib/junk-description.mjs";
import { politeFetch } from "./fetch.mjs";
import { EVENT_TYPES, extractJsonLdBlocks, iterJsonObjects } from "./jsonld.mjs";
import { londonDateKey } from "./time.mjs";
import { httpUrlOrNull } from "../../lib/http-url.mjs";
import { pickImage } from "./jsonld.mjs";
import { probeImage } from "./images.mjs";
import { hasSupabase, restGetAll, isMissingSchemaError } from "./rest.mjs";

// --- description backfill (fetch the event's own page) -----------------------
//
// Runs after cross-source merge, on whatever the adapters + cleanDescription
// didn't already fill: for each row with an empty/short description, fetch
// its own ticket_url page (through the same politeFetch — robots.txt,
// per-host rate limit, 20s timeout, challenge detection, all identical to
// the JSON-LD adapters) and read, in order: the page's own JSON-LD
// Event `description` -> `og:description` -> `<meta name="description">`.
// Capped at MAX_BACKFILL_FETCHES fetches per run so one run can't spiral
// into hundreds of extra requests against dozens of hosts.
//
// The same fetch also yields a PHOTO: a row with no image_url takes the page's
// og:image (else its JSON-LD Event image) — free, and no extra request. A row
// counts as a candidate when its description OR its image is missing, and every
// row the backfill fetched is stamped `enriched_at = now` so the next 14 days'
// runs skip it (events.enriched_at, supabase/add_event_lifecycle.sql) instead
// of re-fetching the same dead pages daily.
//
// Opportunistically also fixes the "date-only source -> stored as midnight
// UTC -> displays as 01:00 during BST" issue (see isMidnightUtcSentinel):
// when a row's starts_at looks like that sentinel and the fetched page's own
// JSON-LD gives a startDate with a real time component for the same
// Europe/London calendar date, the more precise time replaces it.
export const MAX_BACKFILL_FETCHES = 400;
export const ENRICH_SKIP_DAYS = 14;
export const DESCRIPTION_MIN_LENGTH = 40; // matches the measurement threshold: "empty or very short (<40 chars)"

export function needsBackfill(row) {
  // A placeholder ("summary of the event", "TBC", ...) counts as empty.
  return (
    !row.description ||
    row.description.trim().length < DESCRIPTION_MIN_LENGTH ||
    isJunkDescription(row.description, row.name)
  );
}

/** Best-effort {description, startDate, image} from the first schema.org Event object found on an already-fetched page. */
export function extractEventJsonLdFields(html) {
  for (const block of extractJsonLdBlocks(html)) {
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    for (const obj of iterJsonObjects(parsed)) {
      const typeValue = obj["@type"];
      const types = Array.isArray(typeValue) ? typeValue : [typeValue];
      if (!types.some((t) => EVENT_TYPES.has(t))) continue;
      return {
        description: typeof obj.description === "string" ? obj.description : null,
        startDate: typeof obj.startDate === "string" ? obj.startDate : null,
        image: pickImage(obj.image),
      };
    }
  }
  return { description: null, startDate: null, image: null };
}

function metaContent(html, attr, name) {
  const re1 = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*content=["']([^"']*)["'][^>]*>`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${name}["'][^>]*>`, "i");
  return (html.match(re1) || html.match(re2))?.[1] ?? null;
}

// Site-wide share images, not a picture of the event: skip them so the venue's
// photo or the category tile (which are better) get used instead.
const GENERIC_IMAGE_RE = /(^|[/_.-])(logo|favicon|placeholder|no[-_]?image|default[-_]?(image|share|og|social|thumb)|og[-_]?default|share[-_]?default|sprite|blank)([/_.-]|$)/i;

/** The page's own share image: og:image (secure variant, twitter:image as last resort) else the JSON-LD Event image. Resolved against the page URL, http(s) only, generic logos dropped. */
export function extractPageImage(html, pageUrl, ldImage = null) {
  const candidates = [
    metaContent(html, "property", "og:image"),
    metaContent(html, "property", "og:image:secure_url"),
    ldImage,
    metaContent(html, "name", "twitter:image"),
  ];
  for (const raw of candidates) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    let resolved;
    try {
      resolved = new URL(raw.trim().replace(/&amp;/g, "&"), pageUrl).toString();
    } catch {
      continue;
    }
    const url = httpUrlOrNull(resolved);
    if (!url) continue;
    let path;
    try {
      path = new URL(url).pathname;
    } catch {
      continue;
    }
    if (GENERIC_IMAGE_RE.test(path)) continue;
    return url;
  }
  return null;
}

/**
 * Existing rows' enriched_at for the run's providers: Map "provider|id" -> ISO.
 * Empty map when the DB is unreachable or events.enriched_at doesn't exist yet
 * (supabase/add_event_lifecycle.sql not run) — callers then treat every row as never tried.
 */
export async function fetchEnrichedAt(providers, now = new Date()) {
  const map = new Map();
  if (!hasSupabase() || providers.length === 0) return map;
  const list = providers.map((p) => `"${String(p).replace(/"/g, "")}"`).join(",");
  const path =
    `events?select=provider,provider_event_id,enriched_at` +
    `&provider=in.(${encodeURIComponent(list)})` +
    `&enriched_at=not.is.null` +
    `&starts_at=gte.${encodeURIComponent(now.toISOString())}` +
    `&order=id.asc`;
  const res = await restGetAll(path);
  if (!res.ok) {
    if (!isMissingSchemaError(res.error)) {
      console.warn(`[daily-sources] enriched_at lookup failed (${res.status}): ${JSON.stringify(res.error)} — backfill will not skip recently tried rows`);
    }
    return map;
  }
  for (const r of res.rows) map.set(`${r.provider}|${r.provider_event_id}`, r.enriched_at);
  return map;
}

/** True when `iso` is within the last `days` days of `now`. */
export function triedRecently(iso, now, days = ENRICH_SKIP_DAYS) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && now.getTime() - t < days * 86_400_000;
}

/** True if a JSON-LD startDate string carries an explicit time component (not just "YYYY-MM-DD"). */
export function startDateHasTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value.trim());
}

/**
 * `opts.enrichedAt`: fetchEnrichedAt()'s map (rows tried in the last 14 days are skipped).
 * `opts.existingImages`: images.mjs fetchExistingRows()'s map (a row whose DB copy already has a photo doesn't need one).
 * `opts.probe`: image check, injectable for tests. `opts.maxFetches`: cap override.
 */
export async function backfillDescriptions(rows, now, opts = {}) {
  const { enrichedAt = null, existingImages = null, probe = probeImage, maxFetches = MAX_BACKFILL_FETCHES } = opts;
  const stats = {
    candidates: 0,
    skippedRecent: 0,
    imageCandidates: 0,
    imageFromPage: 0,
    imageBroken: 0,
    fetched: 0,
    fetchFailed: 0,
    robotsBlocked: 0,
    foundOnPage: 0,
    datesFixed: 0,
    fallbackUsed: 0,
    alreadyOk: 0,
  };
  const samples = [];
  const imageSamples = [];

  let fetchesUsed = 0;
  for (const row of rows) {
    const key = `${row.provider}|${row.provider_event_id}`;
    const needsDescription = needsBackfill(row);
    const needsImage = !row.image_url && !existingImages?.get(key);
    if (!needsDescription && !needsImage) {
      stats.alreadyOk += 1;
      continue;
    }
    stats.candidates += 1;
    if (needsImage) stats.imageCandidates += 1;
    const recentlyTried = triedRecently(enrichedAt?.get(key), now);
    if (recentlyTried) stats.skippedRecent += 1;

    if (row.ticket_url && !recentlyTried && fetchesUsed < maxFetches) {
      fetchesUsed += 1;
      const before = row.description;
      const result = await politeFetch(row.ticket_url);
      // Stamped on every attempt (a dead page shouldn't be retried daily).
      row.enriched_at = now.toISOString();
      if (!result.ok) {
        stats.fetchFailed += 1;
        if (result.reason === "robots_disallowed" || result.reason === "robots_unavailable") {
          stats.robotsBlocked += 1;
        }
      } else {
        stats.fetched += 1;
        const { description: ldDescription, startDate: ldStartDate, image: ldImage } = extractEventJsonLdFields(result.html);
        const pageDescription = needsDescription
          ? cleanDescription(ldDescription, { title: row.name, venueName: row.venue_name }) ??
            cleanDescription(extractMetaDescription(result.html), { title: row.name, venueName: row.venue_name })
          : null;
        if (pageDescription) {
          row.description = pageDescription;
          stats.foundOnPage += 1;
        }

        if (needsImage) {
          const pageImage = extractPageImage(result.html, result.finalUrl ?? row.ticket_url, ldImage);
          if (pageImage) {
            if ((await probe(pageImage)).ok) {
              row.image_url = pageImage;
              stats.imageFromPage += 1;
              if (imageSamples.length < 10) imageSamples.push({ provider: row.provider, name: row.name, image: pageImage });
            } else {
              stats.imageBroken += 1;
            }
          }
        }

        // Opportunistic date-only -> real-time fix, only when the fetched
        // page's own startDate is for the same Europe/London calendar date
        // (never trust a different date off an unrelated JSON-LD block).
        if (isMidnightUtcSentinel(row.starts_at) && startDateHasTime(ldStartDate)) {
          const fixed = new Date(ldStartDate);
          if (!Number.isNaN(fixed.getTime()) && londonDateKey(fixed.toISOString()) === londonDateKey(row.starts_at)) {
            row.starts_at = fixed.toISOString();
            stats.datesFixed += 1;
          }
        }

        if (samples.length < 10 && row.description !== before) {
          samples.push({ provider: row.provider, name: row.name, before, after: row.description });
        }
      }
    }

    // Only the last resort: a short-but-real description found above (>=15
    // chars via cleanDescription, even if under the 40-char "backfill
    // worth attempting" trigger) is kept as-is, never replaced by the
    // fallback — the fallback is for rows with truly nothing, not for
    // trimming a legitimately short real description.
    // A placeholder that survived (shouldn't post-cleanDescription, but be
    // safe) is treated as empty rather than being stored.
    if (row.description && isJunkDescription(row.description, row.name)) row.description = null;
    if (!row.description) {
      row.description = fallbackDescription(row);
      stats.fallbackUsed += 1;
      if (samples.length < 10) {
        samples.push({ provider: row.provider, name: row.name, before: null, after: row.description, fallback: true });
      }
    }
  }

  return { stats, samples, imageSamples };
}
