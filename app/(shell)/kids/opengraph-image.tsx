import { renderBrandOgImage, OG_IMAGE_SIZE } from "@/lib/og/brand-image";

export const runtime = "nodejs";

export const alt = "Fomo · Free & cheap with kids in Edinburgh";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

/**
 * /kids' own OG/Twitter image. This segment's page sets its own `openGraph`,
 * which replaces the root layout's wholesale, so the route needs its own
 * image file — same reason as app/(shell)/weekend/opengraph-image.tsx.
 */
export default async function Image() {
  return renderBrandOgImage("Free & cheap with kids in Edinburgh");
}
