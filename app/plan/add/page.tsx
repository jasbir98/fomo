"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui";

/**
 * Source: `add_item_menu/code.html`. Full-screen route styled as a bottom
 * sheet (no BottomNav). 4 options; each (except Import) routes to the new
 * itinerary item form prefilled with a category. Close/backdrop → `/plan`.
 */

type AddOption = {
  label: string;
  icon: string;
  category: string | null;
  disabled?: boolean;
};

const OPTIONS: AddOption[] = [
  { label: "Find a Spot", icon: "location_on", category: "activity" },
  { label: "Add Reservation", icon: "confirmation_number", category: "reservation" },
  { label: "Add Note", icon: "edit_document", category: "note" },
  { label: "Import from Email", icon: "mail", category: null, disabled: true },
];

function AddItemMenu() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const day = searchParams.get("day");

  function close() {
    // Return to wherever the user actually opened this sheet from (Home,
    // Plan, a place page, ...) instead of always dumping them on /plan.
    router.back();
  }

  function choose(option: AddOption) {
    if (option.disabled || !option.category) return;
    const params = new URLSearchParams({ category: option.category });
    if (day) params.set("day", day);
    router.push(`/plan/item/new?${params.toString()}`);
  }

  return (
    <div className="relative flex min-h-dvh items-end justify-center bg-primary/40 backdrop-blur-[2px]">
      <button
        type="button"
        aria-label="Close"
        onClick={close}
        className="absolute inset-0"
      />
      <div className="relative w-full rounded-t-3xl bg-surface-container-lowest px-5 pb-safe pt-3 shadow-[0_-8px_32px_rgba(3,22,50,0.12)]">
        <div className="mb-6 flex w-full justify-center">
          <span className="h-1.5 w-12 rounded-full bg-surface-variant" />
        </div>
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-headline-sm text-on-surface">Add to Itinerary</h2>
          <button
            type="button"
            aria-label="Close menu"
            onClick={close}
            className="flex h-12 w-12 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-high"
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-4 pb-8">
          {OPTIONS.map((option) => (
            <button
              key={option.label}
              type="button"
              disabled={option.disabled}
              onClick={() => choose(option)}
              className="group flex min-h-[120px] flex-col items-center justify-center gap-3 rounded-2xl border border-surface-variant bg-surface-container-low p-6 text-center transition-all hover:border-outline-variant hover:bg-surface-container disabled:opacity-40 disabled:hover:border-surface-variant disabled:hover:bg-surface-container-low"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-container-lowest text-secondary-container shadow-sm transition-transform group-hover:scale-110 group-disabled:group-hover:scale-100">
                <Icon name={option.icon} filled size={28} />
              </span>
              <span className="text-label-md text-on-surface">
                {option.label}
                {option.disabled ? (
                  <span className="mt-0.5 block text-label-sm font-normal text-on-surface-variant">
                    Coming soon
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function AddItemPage() {
  return (
    <Suspense fallback={null}>
      <AddItemMenu />
    </Suspense>
  );
}
