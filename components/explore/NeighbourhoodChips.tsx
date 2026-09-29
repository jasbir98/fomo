"use client";

import { NEIGHBOURHOODS } from "@/lib/explore/neighbourhoods";
import { Chip } from "@/components/ui";

export interface NeighbourhoodChipsProps {
  selected: string | null;
  onSelect: (slug: string | null) => void;
}

/** Quick-jump chips for the ten fixed Edinburgh neighbourhoods (lib/explore/neighbourhoods.ts). Tapping the active one again clears the selection. */
export function NeighbourhoodChips({ selected, onSelect }: NeighbourhoodChipsProps) {
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [&::-webkit-scrollbar]:hidden">
      {NEIGHBOURHOODS.map((n) => (
        <Chip
          key={n.slug}
          label={n.label}
          selected={selected === n.slug}
          onClick={() => onSelect(selected === n.slug ? null : n.slug)}
        />
      ))}
    </div>
  );
}

export default NeighbourhoodChips;
