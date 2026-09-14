"use client";

import { BottomSheet, Icon } from "@/components/ui";
import { SELECTABLE_LANGUAGES, languageFromName, type ResolvedLanguage } from "@/lib/language";

export type LanguagePickerProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Currently-selected language name (e.g. `from.label`/`to.label`), highlighted in the list. */
  current?: string;
  onSelect: (lang: ResolvedLanguage) => void;
};

/**
 * BottomSheet listing every selectable language (`SELECTABLE_LANGUAGES`) for
 * the Translator's source/target pickers. Tapping a row resolves it via
 * `languageFromName` and closes the sheet.
 */
export function LanguagePicker({
  open,
  onClose,
  title = "Choose a language",
  current,
  onSelect,
}: LanguagePickerProps) {
  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      <div className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
        {SELECTABLE_LANGUAGES.map(({ name }) => {
          const active = name === current;
          return (
            <button
              key={name}
              type="button"
              onClick={() => {
                onSelect(languageFromName(name));
                onClose();
              }}
              aria-current={active ? "true" : undefined}
              className={`flex items-center justify-between gap-3 rounded-xl px-3 py-3 text-left transition-colors ${
                active
                  ? "bg-primary-fixed/40 text-primary"
                  : "text-on-surface hover:bg-surface-container-low"
              }`}
            >
              <span className="text-label-lg font-medium">{name}</span>
              {active ? (
                <Icon name="check_circle" size={20} filled className="text-primary" />
              ) : null}
            </button>
          );
        })}
      </div>
    </BottomSheet>
  );
}

export default LanguagePicker;
