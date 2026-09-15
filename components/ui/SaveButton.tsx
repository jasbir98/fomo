"use client";

import { Icon } from "./Icon";
import { useSaved } from "@/lib/useSaved";
import type { CardSubjectType } from "@/lib/types";

export type SaveButtonProps = {
  subjectType: CardSubjectType;
  subjectId: string;
  className?: string;
};

/**
 * The one bookmark toggle — feed cards, detail pages and the Explore sheet.
 * State comes from lib/useSaved.ts, so it starts saved when it is saved, and
 * a signed-out tap goes to sign-in and back. Stops propagation so it works
 * inside a whole-card NavCard. 44px tap target.
 */
export function SaveButton({ subjectType, subjectId, className = "" }: SaveButtonProps) {
  const { isSaved, toggle } = useSaved();
  const saved = isSaved(subjectType, subjectId);

  return (
    <button
      type="button"
      aria-pressed={saved}
      aria-label={saved ? "Remove from saved" : "Save"}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void toggle(subjectType, subjectId);
      }}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-surface-container ${
        saved ? "text-primary" : "text-on-surface-variant"
      } ${className}`}
    >
      <Icon name={saved ? "bookmark" : "bookmark_border"} filled={saved} size={22} />
    </button>
  );
}
