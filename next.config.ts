import type { NextConfig } from "next";
import { REMOTE_IMAGE_HOSTNAMES } from "./lib/image/cdn";

// Pre-deploy hardening (Vercel Hobby). Applies to every route via headers()
// below — see each directive's inline reasoning for what it allows and why.
//
// Enforcing (not Report-Only): verified in dev against Supabase auth/realtime,
// Mapbox GL tiles/workers, Google Fonts (Material Symbols + Plus Jakarta
// Sans), and remote event/place photos — no CSP violations in the console
// and every surface still renders. Re-check this list whenever a new
// external host is added anywhere in the app.
// On Vercel preview deployments with Deployment Protection/SSO enabled,
// same-origin requests (e.g. /manifest.json) get redirected through
// https://vercel.com/sso-api?... before the visitor has an SSO session
// cookie. That makes an otherwise same-origin manifest fetch cross-origin,
// so it needs an explicit allowance — but only outside production, where no
// such interception ever happens and the CSP should stay maximally strict.
const isProductionDeploy = process.env.VERCEL_ENV === "production";
// Dev only: React's dev build uses eval() for callstacks, and Vercel Analytics/
// Speed Insights load debug scripts from va.vercel-scripts.com (prod serves them
// same-origin under /_vercel).
const isDev = process.env.NODE_ENV === "development";

const CSP_DIRECTIVES = [
  "default-src 'self'",
  // No nonce infra yet — Next emits inline bootstrap scripts, so
  // 'unsafe-inline' stays here until that's built out. Google Identity
  // Services (GIS) sign-in (app/signin/page.tsx) loads its client script
  // from accounts.google.com/gsi/client — see Google's GIS CSP guidance.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval' https://va.vercel-scripts.com" : ""} https://accounts.google.com/gsi/client`,
  // Tailwind's compiled stylesheet is same-origin; 'unsafe-inline' covers the
  // many inline style={{...}} attributes throughout components and Next's
  // own inline <style> tags. accounts.google.com/gsi/style is GIS's own
  // button stylesheet.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
  // Place/event photos are hotlinked from whatever CDN the source data
  // points at — no fixed allowlist of image hosts is possible here.
  "img-src 'self' https: data: blob:",
  // Explicit rather than relying on the default-src fallback. On preview
  // deployments, Vercel's Deployment Protection SSO redirect turns the
  // same-origin /manifest.json fetch into a request to vercel.com — allow
  // that origin only for non-production deploys (see isProductionDeploy).
  `manifest-src 'self'${isProductionDeploy ? "" : " https://vercel.com"}`,
  "font-src 'self' https://fonts.gstatic.com data:",
  // Supabase (DB + realtime), Mapbox (geocoding/directions + telemetry +
  // tiles), GIS's own XHR/fetch calls (token/credential exchange happens
  // against accounts.google.com/gsi/ from the button's iframe). DeepSeek/
  // Anthropic calls happen server-side only (app/api/chat) so they never
  // need a browser connect-src entry.
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.mapbox.com https://events.mapbox.com https://*.tiles.mapbox.com https://accounts.google.com/gsi/",
  // accounts.google.com/gsi/ is GIS's own button/prompt iframe — the only
  // thing this app frames.
  "frame-src https://accounts.google.com/gsi/",
  // Mapbox GL workers are spun up from blob: URLs.
  "worker-src 'self' blob:",
  "child-src blob:",
  // This app is never meant to be framed by anyone else (pairs with the
  // X-Frame-Options: DENY header below).
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // No Cross-Origin-Opener-Policy header is set anywhere in this app today.
  // If one is ever added, it must be "same-origin-allow-popups" (not
  // "same-origin") — GIS's `ux_mode: 'popup'` (app/signin/page.tsx) opens a
  // same-origin-initiated popup that needs `window.postMessage` back to this
  // page, which a stricter COOP value blocks.
  // Only what the app actually uses: geolocation (lib/geo.ts, Explore's
  // "near me" sort) via the real Geolocation API. No camera/microphone
  // usage anywhere (getUserMedia or otherwise).
  { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=()" },
  { key: "Content-Security-Policy", value: CSP_DIRECTIVES },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ['192.168.0.26', '192.168.129.61', '192.168.1.213'],
  images: {
    formats: ["image/avif", "image/webp"],
    // 30 days — Vercel caches the transformed output at this TTL, and none
    // of these upstream photos (Unsplash/GYG/Viator/etc.) change often
    // enough to need a shorter one.
    minimumCacheTTL: 60 * 60 * 24 * 30,
    // Most placements in this app are small: 64x64 thumbnails, h-28/h-32/h-52
    // cards, a handful of full-bleed heroes. Keeping small entries in
    // imageSizes means a 64px thumbnail gets a ~128px (2x) transform instead
    // of Next's default smallest of 16px jumping straight to 256/384, so
    // small art never rides on a needlessly large generated file.
    deviceSizes: [360, 414, 640, 750, 828, 1080, 1200, 1920],
    imageSizes: [64, 96, 128, 160, 200, 256, 384],
    // Next 16 only accepts listed qualities; SmartImage requests 70 (see components/ui/SmartImage.tsx).
    qualities: [70, 75],
    // Built from lib/image/cdn.ts's REMOTE_IMAGE_HOSTNAMES instead of a
    // second hardcoded list here, so this config and that module's own
    // `isKnownImageHost` can't silently drift apart.
    remotePatterns: REMOTE_IMAGE_HOSTNAMES.map((hostname) => ({
      protocol: "https" as const,
      hostname,
    })),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
  // Trip-era and duplicate screens nothing links to any more — old links and
  // bookmarks land on the Fomo screen that replaced each one. Temporary (307)
  // so the pages can be deleted later without browsers caching the move.
  async redirects() {
    return [
      { source: "/events", destination: "/whats-on", permanent: false },
      { source: "/experiences", destination: "/", permanent: false },
      { source: "/discover/:intent", destination: "/explore", permanent: false },
      { source: "/fomo/translator", destination: "/fomo", permanent: false },
      { source: "/setup/:path*", destination: "/profile", permanent: false },
      { source: "/kit", destination: "/", permanent: false },
      // The Map tab was renamed Explore for good: a real 308 (the old page
      // called redirect() mid-stream, which reached crawlers as a 200 with a
      // meta refresh).
      { source: "/map", destination: "/explore", permanent: true },
    ];
  },
  // PostHog's /ingest/* reverse proxy lives in proxy.ts (it strips cookies
  // before forwarding). This stops Next's trailing-slash redirect from
  // touching those paths first — PostHog's endpoints are picky about it.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
