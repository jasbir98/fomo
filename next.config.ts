import type { NextConfig } from "next";

// Pre-deploy hardening (Vercel Hobby). Applies to every route via headers()
// below — see each directive's inline reasoning for what it allows and why.
//
// Enforcing (not Report-Only): verified in dev against Supabase auth/realtime,
// Mapbox GL tiles/workers, the TikTok/Instagram reel iframe embeds
// (components/social/VideoEmbed.tsx), Google Fonts (Material Symbols +
// Plus Jakarta Sans), and remote event/place photos — no CSP violations in
// the console and every surface still renders. Re-check this list whenever a
// new external host is added anywhere in the app.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  // No nonce infra yet — Next emits inline bootstrap scripts, so
  // 'unsafe-inline' stays here until that's built out.
  "script-src 'self' 'unsafe-inline'",
  // Tailwind's compiled stylesheet is same-origin; 'unsafe-inline' covers the
  // many inline style={{...}} attributes throughout components (e.g.
  // ReelViewer's drag transforms) and Next's own inline <style> tags.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  // Place/event/experience photos and reel posters are hotlinked from
  // whatever CDN the source data points at (or proxied same-origin via
  // /api/media-proxy) — no fixed allowlist of image hosts is possible here.
  "img-src 'self' https: data: blob:",
  "font-src 'self' https://fonts.gstatic.com data:",
  // Supabase (DB + realtime), Mapbox (geocoding/directions + telemetry +
  // tiles). DeepSeek/Anthropic calls happen server-side only (app/api/chat,
  // app/api/translate) so they never need a browser connect-src entry.
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.mapbox.com https://events.mapbox.com https://*.tiles.mapbox.com",
  // TikTok's player/v1 embed and Instagram's /embed iframe (VideoEmbed.tsx).
  "frame-src https://www.tiktok.com https://www.instagram.com",
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
  // Only what the app actually uses: geolocation (lib/geo.ts, Home's "near
  // me" sort) via the real Geolocation API. The translator's photo mode
  // (app/fomo/translator/page.tsx) uses <input type="file" capture> — the
  // OS camera picker, not getUserMedia — so it needs no camera grant here;
  // same reasoning for microphone (no getUserMedia/mic usage anywhere).
  { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=()" },
  { key: "Content-Security-Policy", value: CSP_DIRECTIVES },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ['192.168.0.26', '192.168.129.61', '192.168.1.213'],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
