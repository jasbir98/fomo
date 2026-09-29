"use client";

import { useMemo, useState } from "react";
import { BottomSheet } from "./BottomSheet";
import { Button } from "./Button";
import { Chip } from "./Chip";
import { Icon } from "./Icon";

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterGroupSpec {
  /** Stable key for this dimension (e.g. "timing", "category"). */
  key: string;
  /** Group heading shown inside the sheet (e.g. "Timing"). */
  title: string;
  options: FilterOption[];
  selected: string | null;
  onChange: (value: string | null) => void;
  /**
   * Omit the synthesized "All" chip — the group's default (unfiltered) state
   * is "no chip selected" rather than an explicit "All", and tapping the
   * already-selected chip deselects it back to `null`. Matches the Deals
   * page's WHO row convention (see lib/happenings/groups.ts).
   */
  noAllOption?: boolean;
}

export interface FilterSheetProps {
  groups: FilterGroupSpec[];
  /**
   * Live count of items matching the CURRENT selection. Filters apply live
   * (every chip tap calls that group's `onChange` immediately, same as the
   * old chip rows) — the sheet's "Show N results" footer button is just a
   * close affordance whose label reflects the already-current count, kept
   * consistent across /book-early, /free and /deals.
   */
  resultCount: number;
  /** Trigger button label before any filters are active. Defaults to "Filters". */
  label?: string;
  className?: string;
}

/**
 * Compact filter trigger, replacing 2-3 rows of always-visible chips with a
 * single small "Filters" button (task: "filters should be like a small
 * button rather than that many chips"). Tapping it opens a BottomSheet with
 * one titled group per dimension; an optional thin pills row under the
 * button shows only the currently-active filters, each removable inline.
 *
 * Domain-agnostic — /book-early, /free and /deals each build their `groups`
 * from their own existing filter props/logic (lib/happenings/*-filters.ts,
 * groups.ts) and render this once, so the filter *logic* is untouched and
 * only the presentation is shared.
 */
export function FilterSheet({ groups, resultCount, label = "Filters", className = "" }: FilterSheetProps) {
  const [open, setOpen] = useState(false);

  const activeCount = groups.reduce((n, g) => (g.selected !== null ? n + 1 : n), 0);

  const activePills = useMemo(
    () =>
      groups.flatMap((g) => {
        if (g.selected === null) return [];
        const opt = g.options.find((o) => o.value === g.selected);
        if (!opt) return [];
        return [{ key: g.key, label: opt.label, onRemove: () => g.onChange(null) }];
      }),
    [groups]
  );

  const clearAll = () => {
    for (const g of groups) g.onChange(null);
  };

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border border-primary/30 bg-surface px-3.5 py-1.5 text-label-sm font-semibold text-primary shadow-sm transition-colors hover:bg-surface-container"
      >
        <Icon name="tune" size={16} />
        {activeCount > 0 ? `${label} · ${activeCount}` : label}
      </button>

      {activePills.length > 0 ? (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 py-0.5 [&::-webkit-scrollbar]:hidden">
          {activePills.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={p.onRemove}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-3 py-1.5 text-label-sm font-medium text-primary"
            >
              {p.label}
              <Icon name="close" size={14} />
            </button>
          ))}
        </div>
      ) : null}

      <BottomSheet open={open} onClose={() => setOpen(false)} title="Filters">
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <div key={g.key} className="flex flex-col gap-2">
              <h3 className="text-label-md font-semibold text-on-surface-variant">{g.title}</h3>
              <div className="flex flex-wrap gap-2">
                {!g.noAllOption ? (
                  <Chip label="All" selected={g.selected === null} onClick={() => g.onChange(null)} />
                ) : null}
                {g.options.map((o) => (
                  <Chip
                    key={o.value}
                    label={o.label}
                    selected={g.selected === o.value}
                    onClick={() => g.onChange(g.noAllOption && g.selected === o.value ? null : o.value)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 flex gap-3">
          <Button variant="outline" size="sm" className="flex-1" onClick={clearAll}>
            Clear
          </Button>
          <Button variant="navy" size="sm" className="flex-1" onClick={() => setOpen(false)}>
            Show {resultCount} result{resultCount === 1 ? "" : "s"}
          </Button>
        </div>
      </BottomSheet>
    </div>
  );
}

export default FilterSheet;
