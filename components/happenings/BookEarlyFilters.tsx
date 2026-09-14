"use client";

import { useMemo } from "react";
import { FilterSheet, type FilterGroupSpec } from "@/components/ui";
import { CATEGORY_STYLE } from "@/lib/happenings/category-style";
import { TIMING_LABEL, TIMING_ORDER, type BookEarlyTiming, type MonthFacet } from "@/lib/happenings/book-early-filters";
import type { HappeningCategory } from "@/lib/happenings/types";

export interface BookEarlyFiltersProps {
  timing: BookEarlyTiming | null;
  category: HappeningCategory | null;
  month: string | null;
  /** Only categories actually present among the current (unfiltered) card list — never the full 14-value vocab. */
  categoryOptions: HappeningCategory[];
  /** Only months actually present, already in chronological order. */
  monthOptions: MonthFacet[];
  onTimingChange: (value: BookEarlyTiming | null) => void;
  onCategoryChange: (value: HappeningCategory | null) => void;
  onMonthChange: (value: string | null) => void;
  /** Live count of cards matching the current selection — shown on the sheet's "Show N results" button. */
  resultCount: number;
}

/**
 * The /book-early page's filter trigger — timing, category, month — each
 * still a plain single-select with an "All" option standing in for `null`
 * (same always-has-a-selection convention as DealFilters' WHAT row), just
 * surfaced through the shared FilterSheet (one small button + bottom sheet)
 * instead of three always-visible chip rows. Filter *logic* is untouched:
 * this only rewires presentation onto lib/happenings/book-early-filters.ts's
 * existing facets.
 */
export function BookEarlyFilters({
  timing,
  category,
  month,
  categoryOptions,
  monthOptions,
  onTimingChange,
  onCategoryChange,
  onMonthChange,
  resultCount,
}: BookEarlyFiltersProps) {
  const groups = useMemo<FilterGroupSpec[]>(() => {
    const list: FilterGroupSpec[] = [
      {
        key: "timing",
        title: "Timing",
        options: TIMING_ORDER.map((t) => ({ value: t, label: TIMING_LABEL[t] })),
        selected: timing,
        onChange: (v) => onTimingChange(v as BookEarlyTiming | null),
      },
    ];
    if (categoryOptions.length > 0) {
      list.push({
        key: "category",
        title: "Category",
        options: categoryOptions.map((c) => ({ value: c, label: CATEGORY_STYLE[c].label })),
        selected: category,
        onChange: (v) => onCategoryChange(v as HappeningCategory | null),
      });
    }
    if (monthOptions.length > 1) {
      list.push({
        key: "month",
        title: "Month",
        options: monthOptions.map((m) => ({ value: m.key, label: m.label })),
        selected: month,
        onChange: onMonthChange,
      });
    }
    return list;
  }, [timing, category, month, categoryOptions, monthOptions, onTimingChange, onCategoryChange, onMonthChange]);

  return <FilterSheet groups={groups} resultCount={resultCount} />;
}

export default BookEarlyFilters;
