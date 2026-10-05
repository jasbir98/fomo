"use client";

import { useMemo } from "react";
import { FilterSheet, type FilterGroupSpec } from "@/components/ui";
import {
  WHAT_GROUP_LABEL,
  WHAT_GROUP_ORDER,
  WHO_GROUP_LABEL,
  WHO_GROUP_ORDER,
  type DealWhatGroup,
  type DealWhoGroup,
} from "@/lib/happenings/groups";

export interface DealFiltersProps {
  what: DealWhatGroup | null;
  who: DealWhoGroup | null;
  onWhatChange: (value: DealWhatGroup | null) => void;
  onWhoChange: (value: DealWhoGroup | null) => void;
  /** Live count of deal cards matching the current selection — shown on the sheet's "Show N results" button. */
  /** `null` while the page's data is loading — see FilterSheet. */
  resultCount: number | null;
}

/**
 * The Deals & Offers filter trigger (WHAT / WHO), surfaced through the
 * shared FilterSheet instead of two always-visible chip rows. Filter *logic*
 * is untouched — this only rewires presentation onto lib/happenings/groups.ts.
 *
 * WHAT keeps an explicit "All" option (`noAllOption` unset) — row always has
 * a selection. WHO has none (`noAllOption: true`): the default, unfiltered
 * state is *no* selection (`who === null`, see groups.ts's own note on why
 * member/cardholder rows depend on this), so tapping the already-selected
 * chip deselects it back to that default.
 */
export function DealFilters({ what, who, onWhatChange, onWhoChange, resultCount }: DealFiltersProps) {
  const groups = useMemo<FilterGroupSpec[]>(
    () => [
      {
        key: "what",
        title: "What",
        options: WHAT_GROUP_ORDER.map((g) => ({ value: g, label: WHAT_GROUP_LABEL[g] })),
        selected: what,
        onChange: (v) => onWhatChange(v as DealWhatGroup | null),
      },
      {
        key: "who",
        title: "Who",
        options: WHO_GROUP_ORDER.map((g) => ({ value: g, label: WHO_GROUP_LABEL[g] })),
        selected: who,
        onChange: (v) => onWhoChange(v as DealWhoGroup | null),
        noAllOption: true,
      },
    ],
    [what, who, onWhatChange, onWhoChange]
  );

  return <FilterSheet groups={groups} resultCount={resultCount} />;
}

export default DealFilters;
