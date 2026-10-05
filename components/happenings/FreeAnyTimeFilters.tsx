"use client";

import { useMemo } from "react";
import { FilterSheet, type FilterGroupSpec } from "@/components/ui";

export interface FreeAnyTimeFiltersProps {
  typeLabel: string | null;
  district: string | null;
  /** Only type/district values actually present in the current list — see lib/happenings/free-any-time-filters.ts's `distinctValues`. */
  typeOptions: string[];
  districtOptions: string[];
  onTypeChange: (value: string | null) => void;
  onDistrictChange: (value: string | null) => void;
  /** Live count of items matching the current selection — shown on the sheet's "Show N results" button. */
  /** `null` while the page's data is loading — see FilterSheet. */
  resultCount: number | null;
}

/**
 * The /free page's filter trigger — type and area/district — each still a
 * plain single-select with an explicit "All" option (same convention as
 * DealFilters' WHAT row and BookEarlyFilters), surfaced through the shared
 * FilterSheet instead of two always-visible chip rows. Filter *logic* is
 * untouched — this only rewires presentation onto
 * lib/happenings/free-any-time-filters.ts's existing facets.
 */
export function FreeAnyTimeFilters({
  typeLabel,
  district,
  typeOptions,
  districtOptions,
  onTypeChange,
  onDistrictChange,
  resultCount,
}: FreeAnyTimeFiltersProps) {
  const groups = useMemo<FilterGroupSpec[]>(() => {
    const list: FilterGroupSpec[] = [];
    if (typeOptions.length > 0) {
      list.push({
        key: "type",
        title: "Type",
        options: typeOptions.map((t) => ({ value: t, label: t })),
        selected: typeLabel,
        onChange: onTypeChange,
      });
    }
    if (districtOptions.length > 0) {
      list.push({
        key: "area",
        title: "Area",
        options: districtOptions.map((d) => ({ value: d, label: d })),
        selected: district,
        onChange: onDistrictChange,
      });
    }
    return list;
  }, [typeLabel, district, typeOptions, districtOptions, onTypeChange, onDistrictChange]);

  return <FilterSheet groups={groups} resultCount={resultCount} />;
}

export default FreeAnyTimeFilters;
