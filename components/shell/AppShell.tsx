"use client";

import type { ReactNode } from "react";
import { BottomNav } from "./BottomNav";
import { MakeFomoYours } from "@/components/personalise/MakeFomoYours";
import { closeMakeFomoYours, useMakeFomoYoursOpen } from "@/lib/personalise/trigger";

export type AppShellProps = {
  children: ReactNode;
};

/**
 * Wraps shell routes with the canonical BottomNav and reserves bottom padding
 * so content clears the fixed nav (plus the raised Fomo FAB).
 *
 * 88px = the nav's 64px row + 24px of clearance for the FAB, which pokes
 * -top-6 (24px) above that row — see BottomNav. That base figure assumes no
 * safe area; on real devices BottomNav also carries `pb-safe`
 * (safe-area-inset-bottom), making it taller than 88px whenever that inset is
 * non-zero (any iPhone with a home indicator). A flat 88px here then reserves
 * too little, so the fixed nav visually and functionally overlaps the last
 * stretch of page content — silently swallowing taps there. Match the same
 * inset so this always equals the nav's true rendered height.
 */
export function AppShell({ children }: AppShellProps) {
  // "Make Fomo yours" (components/personalise/MakeFomoYours.tsx) is mounted
  // once here, controlled by the global open/close store
  // (lib/personalise/trigger.ts), rather than owned by whichever page
  // triggers it — it can be opened from a SaveButton on almost any screen,
  // not just Home/Profile.
  const makeFomoYoursOpen = useMakeFomoYoursOpen();
  return (
    <div className="min-h-dvh">
      <div className="pb-[calc(88px+env(safe-area-inset-bottom))]">{children}</div>
      <BottomNav />
      <MakeFomoYours open={makeFomoYoursOpen} onClose={closeMakeFomoYours} />
    </div>
  );
}

export default AppShell;
