// Routes reel thumbnails through our own server-side proxy (app/api/media-proxy)
// instead of hotlinking a scraped CDN URL directly — see that route's
// docstring for why (short-lived signed URLs, not a Referer/CORS problem).
const PROXIED_HOST_SUFFIXES = [
  "tiktokcdn.com",
  "tiktokcdn-eu.com",
  "tiktokcdn-us.com",
  "tiktokcdn-in.com",
  "ibyteimg.com",
  "ttwstatic.com",
  "muscdn.com",
  "cdninstagram.com",
  "fbcdn.net",
];

function needsProxy(hostname: string): boolean {
  return PROXIED_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
  );
}

function isTikTok(platform: string | null | undefined, videoUrl: string | null | undefined): boolean {
  if ((platform ?? "").toLowerCase().includes("tiktok")) return true;
  return /tiktok\.com/i.test(videoUrl ?? "");
}

/**
 * Resolve a reel thumbnail to a URL safe to hotlink from the browser.
 *
 * For TikTok, ignores the (likely expired-by-view-time) stored thumbnail and
 * has the proxy mint a fresh one from `videoUrl` via TikTok's oEmbed API.
 * For everything else, proxies the stored `thumbnailUrl` as-is if it's on a
 * known CDN, or passes it through unchanged.
 */
export function proxiedThumbnailUrl(params: {
  platform?: string | null;
  videoUrl?: string | null;
  thumbnailUrl?: string | null;
}): string | null {
  const { platform, videoUrl, thumbnailUrl } = params;

  if (isTikTok(platform, videoUrl) && videoUrl) {
    return `/api/media-proxy?video=${encodeURIComponent(videoUrl)}`;
  }

  if (!thumbnailUrl) return null;
  try {
    const parsed = new URL(thumbnailUrl);
    if (!needsProxy(parsed.hostname)) return thumbnailUrl;
    return `/api/media-proxy?url=${encodeURIComponent(thumbnailUrl)}`;
  } catch {
    return thumbnailUrl;
  }
}
