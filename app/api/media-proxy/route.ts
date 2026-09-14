/**
 * Fomo Media Proxy — re-serves reel-thumbnail images (server-only).
 *
 * GET /api/media-proxy?video=<encoded TikTok video url>   (preferred for TikTok)
 * GET /api/media-proxy?url=<encoded CDN image url>        (Instagram, or fallback)
 *
 * TikTok's search-page thumbnails (scraper/scrape_tiktok.py) are signed CDN
 * URLs with a short validity window (an `x-expires` param, observed on the
 * order of hours) — by the time a user actually views the reel, the URL
 * stored in the DB has often expired and TikTok's edge returns "Access
 * Denied". Referer/User-Agent do NOT gate this (verified against a live
 * signed URL: it 200s with no Referer at all) — expiry is the only thing
 * that matters. So a naive proxy that just re-fetches the *stored* URL hits
 * the same dead signature the browser would.
 *
 * The fix: TikTok's public oEmbed endpoint (no auth) mints a fresh signed
 * thumbnail URL from the *video* URL, which we always have. So `video=`
 * re-derives a live thumbnail URL at request time instead of trusting
 * whatever was scraped. Instagram has no equivalent public oEmbed since Meta
 * locked it down in 2020, so IG thumbnails fall back to a plain re-fetch via
 * `url=` — same caveat about eventual expiry applies there, just untested.
 */
import "server-only";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ALLOWED_HOST_SUFFIXES = [
  // TikTok CDN
  ".tiktokcdn.com",
  ".tiktokcdn-eu.com",
  ".tiktokcdn-us.com",
  ".tiktokcdn-in.com",
  ".ibyteimg.com",
  ".ttwstatic.com",
  ".muscdn.com",
  // Instagram/Facebook CDN
  ".cdninstagram.com",
  ".fbcdn.net",
];

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function isAllowedHost(hostname: string): boolean {
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix)
  );
}

function refererForHost(host: string): string {
  return host.includes("instagram") || host.includes("cdninstagram") || host.includes("fbcdn")
    ? "https://www.instagram.com/"
    : "https://www.tiktok.com/";
}

async function resolveTikTokThumbnail(videoUrl: string): Promise<string | null> {
  const oembed = new URL("https://www.tiktok.com/oembed");
  oembed.searchParams.set("url", videoUrl);
  const res = await fetch(oembed, { headers: { "User-Agent": MOBILE_UA }, cache: "no-store" });
  if (!res.ok) return null;
  const data = (await res.json()) as { thumbnail_url?: string };
  return data.thumbnail_url ?? null;
}

async function streamImage(rawUrl: string): Promise<NextResponse> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "invalid image url" }, { status: 400 });
  }
  if ((target.protocol !== "https:" && target.protocol !== "http:") || !isAllowedHost(target.hostname)) {
    return NextResponse.json({ error: "host not allowed" }, { status: 400 });
  }
  // Scraped src attributes are sometimes stored as http: even though every
  // one of these CDNs actually serves over https — upgrade before fetching.
  target.protocol = "https:";

  const upstream = await fetch(target, {
    headers: { Referer: refererForHost(target.hostname), "User-Agent": MOBILE_UA },
    cache: "no-store",
  });
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: `upstream responded ${upstream.status}` }, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      // The bytes are fetched fresh every time (see module docstring on
      // why), so this only controls the *browser's* cache, not ours.
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const videoUrl = searchParams.get("video");
  const rawImageUrl = searchParams.get("url");

  if (videoUrl) {
    if (!/^https:\/\/(www\.)?tiktok\.com\//i.test(videoUrl)) {
      return NextResponse.json({ error: "video must be a tiktok.com url" }, { status: 400 });
    }
    try {
      const thumbnail = await resolveTikTokThumbnail(videoUrl);
      if (!thumbnail) {
        return NextResponse.json({ error: "oembed returned no thumbnail" }, { status: 502 });
      }
      return streamImage(thumbnail);
    } catch (err) {
      console.error("[api/media-proxy] oembed lookup failed", err);
      return NextResponse.json({ error: "oembed lookup failed" }, { status: 502 });
    }
  }

  if (rawImageUrl) {
    try {
      return await streamImage(rawImageUrl);
    } catch (err) {
      console.error("[api/media-proxy] fetch failed", err);
      return NextResponse.json({ error: "fetch failed" }, { status: 502 });
    }
  }

  return NextResponse.json({ error: "missing 'video' or 'url' query param" }, { status: 400 });
}
