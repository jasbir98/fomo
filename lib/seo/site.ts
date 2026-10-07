/**
 * Site-wide SEO constants: the canonical origin and the name search engines
 * should associate with it. Shared by app/layout.tsx, app/robots.ts,
 * app/sitemap.ts and the per-page metadata helpers so none of them can drift
 * onto a different origin or spelling.
 *
 * Deliberately NOT `server-only`: it holds no secrets, and keeping it plain
 * lets the unit test import it without Next's server-only guard.
 */

/** Canonical origin, no trailing slash. NEXT_PUBLIC_SITE_URL is set per Vercel environment; production must be https://askfomo.com. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://askfomo.com").replace(/\/+$/, "");

/** The name people search for ("askfomo", "ask fomo"). The app itself still calls itself Fomo in the UI. */
export const SITE_NAME = "Ask Fomo";

export const SITE_TAGLINE = "Free and cheap things to do in Edinburgh";

export const SITE_DESCRIPTION =
  "Free and cheap things to do in Edinburgh, plus student and local deals. Ask Fomo what's on this weekend, tonight or under £10.";

/** Absolute URL for a path on this site ("/weekend" -> "https://askfomo.com/weekend"). */
export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
