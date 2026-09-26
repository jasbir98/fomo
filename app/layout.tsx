import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  // Absolute base for OG/Twitter image URLs on shared links.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://askfomo.com"),
  title: { default: "Fomo — free, cheap and deals in Edinburgh", template: "%s · Fomo" },
  description: "What's on in Edinburgh that's free, cheap or discounted — events, student deals and things to do this weekend.",
  openGraph: {
    siteName: "Fomo",
    type: "website",
    locale: "en_GB",
    title: "Fomo — free, cheap and deals in Edinburgh",
    description: "Never miss the £4 cinema weekend again. What's on in Edinburgh, free, cheap or discounted.",
    images: ["/icons/icon-512.png"],
  },
  twitter: { card: "summary" },
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
    apple: "/icons/icon-192.png",
  },
};

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
      </head>
      <body>
        <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col bg-background">
          {children}
        </div>
        {/* Material Symbols stylesheet: flip media="print" to media="all" once loaded to
            make stylesheet non-render-blocking while falling back gracefully. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              const links = document.querySelectorAll('link[href*="Material+Symbols"]');
              links.forEach((link) => {
                if (link.media === 'print' && link.rel === 'stylesheet') {
                  link.onload = () => { link.media = 'all'; };
                  if (link.sheet) link.media = 'all';
                }
              });
            `,
          }}
        />
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
        <Analytics />
      </body>
    </html>
  );
}
