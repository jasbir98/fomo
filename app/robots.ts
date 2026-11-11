import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo/site";

/**
 * GET /robots.txt. Everything public is crawlable; account/auth surfaces
 * (which 302 to /signin for a signed-out crawler anyway, or are pure
 * personal state) are excluded outright rather than left to noindex alone.
 *
 * /api/ stays blocked EXCEPT the read-only catalogue GETs the public pages
 * load their content from (the same list as PUBLIC_API_PREFIXES in
 * proxy.ts). Googlebot renders pages, and a page whose data request is
 * robots-blocked renders as an empty shell. Where Allow and Disallow both
 * match, the longer (more specific) path wins, so the carve-outs below beat
 * the blanket `/api/`, and the more specific Disallows beat the Allows.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/api/feed", "/api/happenings/", "/api/explore", "/api/weather", "/api/places/"],
      disallow: [
        "/api/",
        // Not page data: calendar downloads and the places lookups used by forms.
        "/api/happenings/*/ics",
        "/api/places/autocomplete",
        "/api/places/resolve",
        "/profile",
        "/fomo",
        "/signin",
        "/auth",
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
