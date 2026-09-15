/**
 * Free, quota-less image resizing via upstream CDN URL parameters.
 *
 * Vercel's built-in image optimizer bills per unique transformed source
 * image and adds a round trip through Vercel's own image proxy. Most of the
 * third-party hosts this app hotlinks from (Unsplash, Google Places/
 * googleusercontent, GetYourGuide, Wikimedia Commons) already support
 * resizing natively via query params or a path segment — asking THEM to
 * resize is both free and one less hop than routing through Next's
 * optimizer. `next/image` (and its Vercel-billed transforms) is kept as the
 * fallback for hosts with no documented *free* resize API — this includes
 * Supabase Storage, whose own image-transform endpoint requires a paid
 * Supabase plan this project isn't on (see the `cdnResize` Supabase branch
 * for details) — as well as hosts with no resize API at all. See
 * `remotePatterns` in next.config.ts, which is generated from
 * `REMOTE_IMAGE_HOSTNAMES` below so the two lists can't drift apart.
 */

export type ImageTransform = {
  width: number;
  /** 1-100, defaults to a card-appropriate 70 when omitted. */
  quality?: number;
  /** Device pixel ratio hint (1-3) — only a few CDNs (Unsplash) support this
   *  as a first-class param instead of a pre-multiplied `width`. */
  dpr?: number;
};

const MAX_WIDTH = 2048;
const MIN_WIDTH = 16;
const DEFAULT_QUALITY = 70;
const MAX_DPR = 3;

/**
 * Hostnames next/image is allowed to optimize remotely — mirrors
 * next.config.ts's `images.remotePatterns` (that file builds its
 * remotePatterns array from this same list) and this module's own
 * `isOptimizableRemote`, so both stay in sync from one source of truth.
 * Supports Next's `**.` wildcard-subdomain prefix and a trailing `.*`
 * wildcard TLD (e.g. `**.ticketmaster.*`).
 */
export const REMOTE_IMAGE_HOSTNAMES = [
  "images.unsplash.com",
  "**.unsplash.com",
  "**.supabase.co",
  "**.googleusercontent.com",
  "maps.googleapis.com",
  "**.getyourguide.com",
  "**.viator.com",
  "**.livenationinternational.com",
  "**.ticketm.net",
  "**.ticketmaster.*",
  "**.skiddle.com",
  "**.tiktokcdn.com",
  "**.tiktokcdn-eu.com",
  "**.tiktokcdn-us.com",
  "**.cdninstagram.com",
  "**.fbcdn.net",
  "**.ibyteimg.com",
  "**.ttwstatic.com",
  "**.muscdn.com",
  "upload.wikimedia.org",
  "commons.wikimedia.org",
] as const;

/**
 * Mirrors Next.js's real remote-pattern matching (internally: picomatch's
 * `makeRe(pattern.hostname).test(hostname)` — see
 * node_modules/next/dist/shared/lib/match-remote-pattern.js) closely enough
 * to be safe for the two pattern shapes actually used in
 * `REMOTE_IMAGE_HOSTNAMES`: an exact hostname, or a `**.`-prefixed pattern
 * (optionally with a trailing `.*` wildcard TLD).
 *
 * The one property this MUST get right: picomatch's `**` requires at least
 * one preceding label — `**.unsplash.com` does NOT match the bare apex
 * `unsplash.com` (verified empirically against picomatch's own `makeRe`).
 * An earlier version of this function got that backwards (`host === suffix`
 * counted as a match), which meant `isKnownImageHost` could return `true`
 * for a host next/image's *real*, picomatch-backed check then rejects —
 * throwing `Invalid src prop ... hostname "X" is not configured` at render
 * time and white-screening the page. Any pattern shape other than the two
 * handled below is intentionally NOT matched (returns `false`) rather than
 * guessed at: a false negative just costs a missed free-CDN-resize/next-
 * image-optimized path (SmartImage falls back to `unoptimized`), whereas a
 * false positive risks that same render-time crash. When in doubt, don't match.
 */
function hostMatchesPattern(host: string, pattern: string): boolean {
  if (host === pattern) return true;
  if (!pattern.startsWith("**.")) return false;

  const suffix = pattern.slice(3);
  if (suffix.endsWith(".*")) {
    // e.g. "**.ticketmaster.*" — needs >=1 label before "ticketmaster", then
    // a literal "." + any non-empty TLD remainder (hostnames have no "/", so
    // picomatch's trailing `*` segment matches through any remaining dots —
    // confirmed empirically: "**.ticketmaster.*" matches
    // "www.ticketmaster.co.uk" too, not just single-label TLDs).
    const base = suffix.slice(0, -2);
    return host.includes(`.${base}.`);
  }
  // e.g. "**.unsplash.com" — requires a non-empty subdomain label before the
  // suffix; the bare apex ("unsplash.com") must NOT match.
  return host.endsWith(`.${suffix}`);
}

/** Whether `hostname` is one next/image is configured to optimize (see `REMOTE_IMAGE_HOSTNAMES`). */
export function isKnownImageHost(hostname: string): boolean {
  return REMOTE_IMAGE_HOSTNAMES.some((pattern) => hostMatchesPattern(hostname, pattern));
}

/**
 * Upgrades a plain `http://` URL to `https://`, otherwise returns `src`
 * unchanged. Scraped source data occasionally stores a venue's image as
 * `http://` even though the host actually serves it over https (the same
 * class of bug already fixed once for the reel-thumbnail proxy — see
 * app/api/media-proxy/route.ts's `streamImage`, which upgrades before
 * fetching) — and this app's CSP `img-src` directive (next.config.ts) is
 * `'self' https: data: blob:`, which does NOT include plain `http:`. Left
 * un-rewritten, the browser silently drops the request (a CSP violation, not
 * a network error), so `<img>`'s `onerror` never fires and SmartImage has no
 * signal to fall back on — it just renders a permanently broken image box.
 * Rewriting the URL before it ever reaches an `<img>`/`next/image` src fixes
 * that at the source instead of trying to detect a CSP block after the fact.
 * `data:`/`blob:` URIs and same-origin relative paths never start with
 * `http://`, so they pass through untouched.
 */
export function toHttpsUrl(src: string): string {
  return src.startsWith("http://") ? `https://${src.slice("http://".length)}` : src;
}

/**
 * Whether `src` is a genuine remote http(s) URL worth handing to an image
 * optimizer at all — false for `data:`/`blob:` URIs (already-local, in-memory
 * images) and same-origin relative paths like `/api/media-proxy?...`, both of
 * which must never be rewritten or sent through next/image's remote path.
 */
export function isOptimizableRemote(src: string): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 256;
  return Math.min(Math.max(Math.round(width), MIN_WIDTH), MAX_WIDTH);
}

function clampDpr(dpr: number): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.min(Math.round(dpr), MAX_DPR);
}

/**
 * The only thumbnail widths upload.wikimedia.org will serve. Wikimedia stores
 * thumbnails indefinitely, so they restricted generation to these steps
 * ($wgThumbnailSteps, phab:T414805): requests that go through PHP get rounded
 * up to the nearest one, but **direct hotlinks like ours are rejected with an
 * HTTP 400** ("Use thumbnail sizes listed on https://w.wiki/GHai") for any
 * other width. Verified live: 120/250/330/500/960/1280/1920/3840 all 200,
 * while 128px and 160px — widths this module used to emit straight from
 * next.config.ts's `imageSizes` — both 400.
 */
const WIKIMEDIA_THUMB_STEPS = [20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840];
// Cap at 1920 rather than 3840. `clampWidth` already limits any request to
// MAX_WIDTH (2048), and 2048 is only ~6% wider than 1920 — rounding it up to
// 3840 instead would roughly quadruple the bytes for an imperceptible gain.
const WIKIMEDIA_MAX_STEP = 1920;

/** Snaps `width` up to the smallest Wikimedia-allowed thumbnail step. */
function wikimediaThumbWidth(width: number): number {
  return (
    WIKIMEDIA_THUMB_STEPS.find((step) => step >= width && step <= WIKIMEDIA_MAX_STEP) ??
    WIKIMEDIA_MAX_STEP
  );
}

/**
 * Rewrites `src` into a resized variant using the upstream host's own
 * transform API, or returns `null` when the host isn't recognised (the
 * caller — SmartImage — then falls back to next/image, or renders the URL
 * as-is for a host next/image also can't optimize). Never throws: malformed
 * URLs, `data:`/`blob:` URIs, and same-origin relative paths (e.g. this
 * app's own `/api/media-proxy?...`) always return `null`.
 */
export function cdnResize(src: string, t: ImageTransform): string | null {
  if (!src || src.startsWith("data:") || src.startsWith("blob:") || src.startsWith("/")) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const width = clampWidth(t.width);
  const quality = Math.min(Math.max(Math.round(t.quality ?? DEFAULT_QUALITY), 1), 100);
  const host = url.hostname;

  // Unsplash — imgix-compatible query params.
  if (host === "images.unsplash.com" || host.endsWith(".unsplash.com")) {
    url.searchParams.set("w", String(width));
    url.searchParams.set("q", String(quality));
    url.searchParams.set("auto", "format");
    url.searchParams.set("fit", "crop");
    if (t.dpr) url.searchParams.set("dpr", String(clampDpr(t.dpr)));
    return url.toString();
  }

  // Supabase Storage — DO NOT re-enable the `/storage/v1/render/image/public/`
  // rewrite that used to live here. That endpoint is Supabase's image
  // transformation API, which is a **paid Pro-tier feature** — on the Free
  // tier (this project's current plan, confirmed with the project owner) it
  // errors instead of resizing, which would break every single Supabase-
  // hosted image in the app. Supabase Storage hosts stay in
  // `REMOTE_IMAGE_HOSTNAMES` below (`**.supabase.co`) purely so SmartImage
  // routes them through `next/image` (Vercel-billed, but correct) instead of
  // an un-resized original. Only bring this rewrite back if/when the
  // project is confirmed upgraded to a tier with image transformations
  // enabled — never re-add it "to save cost" without checking that first.
  if (host.endsWith(".supabase.co") && url.pathname.includes("/storage/v1/object/public/")) {
    return null;
  }

  // Google Places Photo API (Legacy) — `maxwidth`/`maxheight` are the
  // documented sizing params, and one of them is REQUIRED for every request
  // (this is not an optional resize-on-top-of-a-fetch; it IS the fetch).
  // Per Google's docs both params accept 1-1600 only — clamp separately from
  // the shared 2048 MAX_WIDTH, or a hero/2x request could ask for e.g. 1800
  // and get an HTTP 400 instead of an image. Rewriting maxwidth doesn't add
  // a second billed request: exactly one srcSet candidate is ever actually
  // fetched by the browser, same as an unrewritten <img> would trigger.
  if (host === "maps.googleapis.com") {
    if (!url.pathname.includes("/photo")) return null;
    const placesMaxWidth = Math.min(width, 1600);
    url.searchParams.set("maxwidth", String(placesMaxWidth));
    url.searchParams.delete("maxheight");
    return url.toString();
  }

  // googleusercontent (Google-hosted photo CDN, incl. some Places photos
  // redirected here) — size is a "=w{n}-h{n}-c" segment appended to the path.
  if (host.endsWith(".googleusercontent.com")) {
    const sizeSegment = `=w${width}-h${width}-c`;
    url.pathname = /=w\d+-h\d+(-[a-z0-9-]*)?$/i.test(url.pathname)
      ? url.pathname.replace(/=w\d+-h\d+(-[a-z0-9-]*)?$/i, sizeSegment)
      : `${url.pathname}${sizeSegment}`;
    return url.toString();
  }

  // GetYourGuide — size is a documented `/{w}x{h}/` path segment when present
  // (e.g. `/img/tour_img-xxx/68x68/...`); some GYG image paths carry no size
  // segment at all, and those fall through to next/image instead of guessing.
  if (host.endsWith(".getyourguide.com")) {
    if (!/\/\d+x\d+\//.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/\/\d+x\d+\//, `/${width}x${width}/`);
    return url.toString();
  }

  // Wikimedia Commons — served from upload.wikimedia.org, always under
  // /wikipedia/<commons|lang>/<hash1>/<hash1hash2>/<filename>, optionally
  // already thumbnailed under an extra /thumb/ segment with a trailing
  // "/{width}px-{filename}" (scraper/photos_wikimedia.py stores the API's
  // own ~1000px `thumburl`, so this is the common case, not an edge case).
  if (host === "upload.wikimedia.org") {
    // Wikimedia only generates thumbnails at fixed steps and 400s on anything
    // else (see WIKIMEDIA_THUMB_STEPS) — snap before building either path.
    const thumbWidth = wikimediaThumbWidth(width);

    // Already a thumb URL — swap the existing width prefix for ours. Works
    // unchanged for SVG sources too: their thumb filename already carries
    // Wikimedia's own added ".png" suffix in this exact segment (e.g.
    // "220px-Example.svg.png"), and nothing after "px-" is touched.
    const thumbMatch = url.pathname.match(
      /^(\/wikipedia\/[^/]+\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/[^/]+\/)\d+px-(.+)$/i
    );
    if (thumbMatch) {
      url.pathname = `${thumbMatch[1]}${thumbWidth}px-${thumbMatch[2]}`;
      return url.toString();
    }

    // A bare original file URL (no /thumb/ segment yet) — build the thumb
    // path from scratch. SVGs render to a PNG thumbnail, hence appending
    // ".png" to the filename inside the "{width}px-" segment specifically
    // (the original /<hash>/<hash2>/Example.svg path itself is untouched).
    const originalMatch = url.pathname.match(/^\/wikipedia\/([^/]+)\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)$/i);
    if (originalMatch) {
      const [, wiki, h1, h2, filename] = originalMatch;
      const thumbName = /\.svg$/i.test(filename) ? `${filename}.png` : filename;
      url.pathname = `/wikipedia/${wiki}/thumb/${h1}/${h2}/${filename}/${thumbWidth}px-${thumbName}`;
      return url.toString();
    }

    // Unrecognised path shape (e.g. a Special:FilePath redirect) — don't
    // guess at a rewrite that might 404.
    return null;
  }

  // Ticketmaster / Live Nation / ticketm.net serve fixed pre-baked image
  // variants with no documented resize API — don't guess, let next/image
  // (or an unoptimized <img>, per SmartImage's host check) handle it.
  return null;
}
