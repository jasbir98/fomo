import { ImageResponse } from "next/og";
import { OG_IMAGE_SIZE } from "@/lib/og/brand-image";
import { MASCOT_DATA_URL } from "@/lib/og/mascot-data-url";

export const runtime = "nodejs";

export const alt = "Fomo · For you: Edinburgh's best steals this week";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

/**
 * /for-you's own OG/Twitter image: the same layout as the other brand cards
 * (lib/og/brand-image.tsx, as /weekend's does) but on the orange -> pink ->
 * purple gradient of the Instagram "Fomo Finds" series (--color-find-* in
 * app/globals.css) instead of navy. Needed for the same reason /weekend has
 * one: this segment's layout sets its own `openGraph`, which replaces the root
 * layout's image wholesale, and a segment-level opengraph-image file is picked
 * up and combined with it.
 *
 * Text colour: the card's headline is white at 64px bold, which is "large
 * text" (3:1 needed); against the gradient's lightest stop (#FF8A3D) white is
 * 2.35:1, so the whole headline sits over a translucent dark scrim panel
 * instead of straight on the gradient. The kicker and subline use the same
 * panel. (Satori can't take CSS variables, so the hex values are repeated here.)
 */
export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "linear-gradient(135deg, #ff8a3d 0%, #ff3d7f 52%, #8b5cf6 100%)",
          padding: "0 80px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 18,
            maxWidth: 680,
            padding: "36px 40px",
            borderRadius: 40,
            background: "rgba(27, 20, 60, 0.62)",
          }}
        >
          <div
            style={{
              display: "flex",
              color: "#ffd3b3",
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: "uppercase",
            }}
          >
            Fomo
          </div>
          <div style={{ display: "flex", fontSize: 64, fontWeight: 700, lineHeight: 1.15, color: "#ffffff" }}>
            For you: Edinburgh&apos;s best steals this week
          </div>
          <div style={{ display: "flex", fontSize: 30, color: "#e9e1ff" }}>askfomo.com</div>
        </div>
        {/* next/og renders through satori, not the browser/React DOM, so only a plain <img> works here. */}
        <img
          src={MASCOT_DATA_URL}
          width={300}
          height={300}
          alt=""
          style={{ borderRadius: 48, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}
        />
      </div>
    ),
    { ...OG_IMAGE_SIZE }
  );
}
