import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Fomo",
  description: "Fomo — what's on in Edinburgh: events, free things and deals.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Fomo",
  },
  icons: {
    icon: "/icons/icon-192.png",
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
        {/* Material Symbols variable icon font — intentionally a raw <link> (not next/font). */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font, @next/next/google-font-display */}
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col bg-background">
          {children}
        </div>
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
      </body>
    </html>
  );
}
