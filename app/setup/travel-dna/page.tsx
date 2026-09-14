"use client";

import { Suspense } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { TasteForm } from "@/components/onboarding/TasteForm";

/**
 * `/setup/travel-dna` (plan §B.2) — reduced from a standalone form to a
 * thin wrapper around the shared `TasteForm` (components/onboarding/TasteForm.tsx),
 * in edit mode, so Profile's `?edit=1` link (`app/(shell)/profile/page.tsx`)
 * keeps working. All the actual field logic — including the fix for the old
 * inverted-slider-labels bug (there's no slider left at all now, see
 * TasteForm's doc comment) — lives in the shared component.
 */
function TravelDnaPage() {
  const router = useRouter();

  return (
    <div className="flex min-h-dvh w-full flex-col bg-background pb-10">
      <PageHeader showBack />
      <main className="mx-auto w-full max-w-md flex-1 px-5 pt-2">
        <TasteForm mode="edit" onSaved={() => router.push("/profile")} />
      </main>
    </div>
  );
}

export default function TravelDnaPageWrapper() {
  return (
    <Suspense fallback={null}>
      <TravelDnaPage />
    </Suspense>
  );
}
