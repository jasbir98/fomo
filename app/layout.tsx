import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { InstallCapture } from "@/components/install/InstallCapture";
import { JsonLd } from "@/components/seo/JsonLd";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, SITE_URL, absoluteUrl } from "@/lib/seo/site";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  // Absolute base for canonical and OG/Twitter image URLs.
  metadataBase: new URL(SITE_URL),
  applicationName: SITE_NAME,
  title: { default: `${SITE_NAME} · ${SITE_TAGLINE}`, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  // No canonical here: it would be inherited by every page that doesn't set
  // its own and point them all at the home page. Each page sets its own
  // (lib/seo/metadata.ts's `pageMetadata`).
  openGraph: {
    siteName: SITE_NAME,
    type: "website",
    locale: "en_GB",
    title: `${SITE_NAME} · ${SITE_TAGLINE}`,
    description: "Never miss the £4 cinema weekend again. Free and cheap things to do in Edinburgh, plus student and local deals.",
    // No static `images` here — app/opengraph-image.tsx (next/og) is
    // picked up automatically per-route as the branded default and
    // supersedes the old static icon-512.png link-preview image. A route
    // that needs its own image still wins by either defining its own
    // opengraph-image.tsx (e.g. app/(shell)/weekend/) or an explicit
    // `openGraph.images` in its own metadata/generateMetadata (e.g.
    // happening/event detail layouts).
  },
  twitter: { card: "summary_large_image", title: `${SITE_NAME} · ${SITE_TAGLINE}`, description: SITE_DESCRIPTION },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Fomo",
  },
  icons: {
    icon: [
      { rel: "icon", type: "image/svg+xml", url: "/icons/icon.svg" },
      { rel: "icon", type: "image/png", sizes: "192x192", url: "/icons/icon-192.png" },
    ],
    apple: "/icons/apple-touch-icon-180.png",
  },
};

// Tells search engines the site's name and its common spellings, so a search
// for "askfomo" or "ask fomo" resolves here. No `sameAs` yet: add the
// Instagram profile URL once it is linked from the app.
const SITE_JSON_LD = [
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    alternateName: ["AskFomo", "Fomo Edinburgh", "askfomo.com"],
    url: SITE_URL,
  },
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
    logo: absoluteUrl("/icons/icon-512.png"),
  },
];

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#1b365d",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${jakarta.variable} antialiased`} suppressHydrationWarning>
      <head>
        <JsonLd data={SITE_JSON_LD} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Material Symbols: narrowed to actual usage — opsz 20..48 (valid axis range;
            smaller sizes are clamped by browser), wght 100..700 (full range preserved; Icon
            component supports variable weights), FILL 0..1 (filled/unfilled), GRAD dropped
            (hardcoded 0, never varies).

            Loaded as an ordinary render-blocking stylesheet, NOT the
            media="print" async trick. Without JS to flip `media` back to
            "all" (a Server Component can't attach the required onLoad
            handler), a print-media stylesheet simply never applies to the
            screen — which left every <Icon> rendering its raw ligature name
            ("home", "search") as visible text. The response is a ~1KB CSS
            file of @font-face rules, and until it applies the icons are
            literal words, so blocking on it is also the better UX than a
            flash of unstyled ligatures. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font, @next/next/google-font-display */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL@20..48,100..700,0..1"
        />
        {/* Inline scripts live in <head>, never <body>: PostHog inserts its
            config.js before the first `body > script`, and React would then try
            to hydrate that injected tag as ours (attribute mismatch). */}
        {/* Skip SW registration outside production: Turbopack's dev server + hand-rolled
            sw.js (no HMR-awareness) is one thing, but the real trigger for the console
            noise is CDP/automation-driven Chrome (this Browser pane included) rejecting
            the registration outright with "An unknown error occurred when fetching the
            script" even though /sw.js serves fine (verified via curl) — a known
            automation-profile quirk, not an app bug. There's nothing to precache or work
            offline for in dev, so just don't register there. */}
        {process.env.NODE_ENV === "production" && (
          <script
            dangerouslySetInnerHTML={{
              __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}`,
            }}
          />
        )}
      </head>
      <body>
        {/* Phone column below lg (1024px); full width from lg up, where AppShell
            adds the side nav and pages cap their own content width. */}
        <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col bg-background lg:max-w-none">
          {children}
        </div>
        <InstallCapture />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
