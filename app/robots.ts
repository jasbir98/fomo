import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://askfomo.com";

/**
 * GET /robots.txt. Everything public is crawlable; account/auth surfaces
 * (which 302 to /signin for a signed-out crawler anyway, or are pure
 * personal state) are excluded outright rather than left to noindex alone.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/profile", "/fomo", "/signin", "/welcome", "/auth"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
