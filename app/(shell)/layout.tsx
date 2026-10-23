import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { NowProvider } from "@/lib/useNow";

export default function ShellLayout({ children }: { children: ReactNode }) {
  // The time this page was built, so the client's first render can reproduce
  // the cached HTML's time-dependent labels (see lib/useNow.tsx).
  return (
    <NowProvider serverNow={new Date().toISOString()}>
      <AppShell>{children}</AppShell>
    </NowProvider>
  );
}
