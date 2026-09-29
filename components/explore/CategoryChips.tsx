"use client";

import { EXPLORE_CATEGORIES, type ExploreCategorySlug } from "@/lib/explore/categories";
import { Chip } from "@/components/ui";

export interface CategoryChipsProps {
  selected: ExploreCategorySlug[];
  onToggle: (slug: ExploreCategorySlug) => void;
}

/** Multi-select Edinburgh category chips (Food & drink, Cafés, Pubs & bars, …) — real `places.category` groupings, see lib/explore/categories.ts's header for where they came from. Selecting more than one is OR, not AND. */
export function CategoryChips({ selected, onToggle }: CategoryChipsProps) {
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [&::-webkit-scrollbar]:hidden">
      {EXPLORE_CATEGORIES.map((c) => (
        <Chip
          key={c.slug}
          label={c.label}
          leadingIcon={c.icon}
          selected={selected.includes(c.slug)}
          onClick={() => onToggle(c.slug)}
        />
      ))}
    </div>
  );
}

export default CategoryChips;
