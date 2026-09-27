"use client";

import { useEffect } from "react";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { reportError } from "@/lib/analytics/report-error";

/**
 * Last-resort error boundary — only fires when the ROOT layout itself
 * throws (app/layout.tsx), which is the one place app/error.tsx can't
 * catch (it renders *inside* the root layout). Per Next's convention this
 * replaces the whole document, so it must render its own <html>/<body> —
 * the root layout's <head> (globals.css, the Material Symbols stylesheet,
 * the font variable) never mounts here. Inline styles only; no Tailwind
 * classes, no `material-symbols` icon font, no BottomNav. FomoSpot is safe
 * to use regardless — components/onboarding/Characters.tsx paints with
 * literal hex constants, not CSS custom properties, so it renders correctly
 * with zero stylesheet.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reportError(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#f8f9ff", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        {/* FomoSpot's own default sizing (h-24 w-24) is a Tailwind utility class,
            which has nothing to interpret it here — this file can't assume
            globals.css loaded. Size it with a plain scoped <style> instead, so
            the mascot renders at a sane size with zero external stylesheet. */}
        <style>{`.ge-mascot{width:112px;height:112px;}`}</style>
        <div
          style={{
            display: "flex",
            minHeight: "100dvh",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            padding: "24px",
            textAlign: "center",
          }}
        >
          <FomoSpot mood="gasp" pose="shrug" className="ge-mascot" />
          <div>
            <h1 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 700, color: "#1b365d" }}>
              Fomo tripped over something
            </h1>
            <p style={{ margin: 0, maxWidth: 280, fontSize: 15, color: "#44474e" }}>
              The app hit a snag loading. Try again in a moment.
            </p>
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 12 }}>
            <button
              type="button"
              onClick={reset}
              style={{
                minHeight: 48,
                padding: "0 24px",
                borderRadius: 999,
                border: "none",
                background: "#2c5282",
                color: "#ffffff",
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            {/* Plain <a>, deliberately not next/link: the root layout just
                threw, so this document's own App Router client context can't
                be assumed intact — a full navigation is the reliable escape
                hatch here, matching Next's own global-error.js examples. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              style={{
                minHeight: 48,
                display: "inline-flex",
                alignItems: "center",
                padding: "0 24px",
                borderRadius: 999,
                border: "1.5px solid #1b365d",
                color: "#1b365d",
                fontSize: 15,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Back to Fomo
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
