"use client";

import { use } from "react";
import { PlaceDetail } from "@/components/detail/PlaceDetail";

/**
 * Place detail route. The whole page lives in components/detail/PlaceDetail.tsx
 * so the desktop overlay (components/detail/DetailOverlayProvider.tsx) can
 * render the same thing as a modal.
 */
export default function PlaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <PlaceDetail id={id} />;
}
