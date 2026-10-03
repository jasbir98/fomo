"use client";

import { use } from "react";
import { EventDetail } from "@/components/detail/EventDetail";

/**
 * Event detail route. The whole page lives in components/detail/EventDetail.tsx
 * so the desktop overlay (components/detail/DetailOverlayProvider.tsx) can
 * render the same thing as a modal.
 */
export default function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <EventDetail id={id} />;
}
