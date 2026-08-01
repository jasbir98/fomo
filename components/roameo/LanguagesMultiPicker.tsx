"use client";

import { useState } from "react";
import { Button, BottomSheet, Icon } from "@/components/ui";
import { SELECTABLE_LANGUAGES } from "@/lib/language";

export type LanguagesMultiPickerProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Currently-selected language names, checked in the list. */
  selected: string[];
  onToggle: (name: string) => void;
};

/**
 * Multi-select BottomSheet variant of `LanguagePicker`, for "languages I
 * speak" in the Travel DNA form. Unlike the single-select picker, tapping a
 * row toggles it and keeps the sheet open so several languages can be
 * picked in one visit. A text filter narrows the ~40-entry `SELECTABLE_LANGUAGES`
 * list, which is also what validates entries — there's no free-text path in.
 */
export function LanguagesMultiPicker({
  open,
  onClose,
  title = "Languages I speak",
  selected,
  onToggle,
}: LanguagesMultiPickerProps) {
  const [filter, setFilter] = useState("");

  const languages = SELECTABLE_LANGUAGES.filter(({ name }) =>
    name.toLowerCase().includes(filter.trim().toLowerCase())
  );

  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-3">
        <div className="flex h-11 items-center gap-2 rounded-xl border border-outline-variant bg-surface-container-lowest px-3">
          <Icon name="search" size={18} className="text-on-surface-variant" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search languages…"
            className="flex-1 bg-transparent text-body-md text-on-surface placeholder:text-on-surface-variant outline-none"
          />
        </div>

        <div className="flex max-h-[45vh] flex-col gap-1 overflow-y-auto">
          {languages.length ? (
            languages.map(({ name }) => {
              const active = selected.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => onToggle(name)}
                  aria-pressed={active}
                  className={`flex items-center justify-between gap-3 rounded-xl px-3 py-3 text-left transition-colors ${
                    active
                      ? "bg-primary-fixed/40 text-primary"
                      : "text-on-surface hover:bg-surface-container-low"
                  }`}
                >
                  <span className="text-label-lg font-medium">{name}</span>
                  <Icon
                    name={active ? "check_circle" : "radio_button_unchecked"}
                    size={20}
                    filled={active}
                    className={active ? "text-primary" : "text-outline"}
                  />
                </button>
              );
            })
          ) : (
            <p className="px-3 py-6 text-center text-body-sm text-on-surface-variant">
              No languages match &ldquo;{filter}&rdquo;.
            </p>
          )}
        </div>

        <Button variant="orange" fullWidth onClick={onClose}>
          Done
        </Button>
      </div>
    </BottomSheet>
  );
}

export default LanguagesMultiPicker;
