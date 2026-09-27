import { ImageResponse } from "next/og";
import { MASCOT_DATA_URL } from "./mascot-data-url";

export const OG_IMAGE_SIZE = { width: 1200, height: 630 };

/**
 * Shared 1200x630 branded OG/Twitter image layout — navy background, the
 * mascot, an uppercase "Fomo" kicker, a big headline, and a subline (the
 * site domain by default). Used by app/opengraph-image.tsx (the site-wide
 * default) and by per-route variants such as app/(shell)/weekend/
 * opengraph-image.tsx, so every share card looks like one family instead of
 * each route reinventing the layout.
 */
export function renderBrandOgImage(headline: string, subline: string = "askfomo.com") {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "#1b365d",
          padding: "0 80px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 640 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              color: "#fc8a40",
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: "uppercase",
            }}
          >
            Fomo
          </div>
          <div style={{ display: "flex", fontSize: 64, fontWeight: 700, lineHeight: 1.15, color: "#ffffff" }}>
            {headline}
          </div>
          <div style={{ display: "flex", fontSize: 30, color: "#aec7f7" }}>{subline}</div>
        </div>
        {/* next/og renders through satori, not the browser/React DOM — only
            a plain <img> is supported here, never next/image. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={MASCOT_DATA_URL}
          width={340}
          height={340}
          alt=""
          style={{ borderRadius: 48, boxShadow: "0 20px 60px rgba(0,0,0,0.35)" }}
        />
      </div>
    ),
    { ...OG_IMAGE_SIZE }
  );
}
