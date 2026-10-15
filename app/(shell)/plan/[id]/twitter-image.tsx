import { renderPlanReceiptImage } from "@/lib/og/receipt-image";
import { OG_IMAGE_SIZE } from "@/lib/og/brand-image";
import { getPlan } from "@/lib/plans/db";

export const runtime = "nodejs";

export const alt = "A weekend plan on Fomo: the picks, their prices and the total";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/jpeg";

/** Same receipt as ./opengraph-image.tsx (route config can't be re-exported, so it's restated). */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = await getPlan(id).catch(() => null);
  return renderPlanReceiptImage(plan);
}
