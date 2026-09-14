"use client";

import { useEffect, useState } from "react";
import { Button, Chip, Icon, SegmentedControl } from "@/components/ui";
import type { SegmentOption } from "@/components/ui";
import { LanguagesMultiPicker } from "@/components/fomo/LanguagesMultiPicker";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { getPreferences, upsertPreferences } from "@/lib/db";
import { DIETARY_OPTIONS, INTEREST_TAGS, INTEREST_TAG_META, type InterestTag } from "@/lib/taxonomy";

/**
 * Shared taste/preferences form (plan-v1.2-accounts.md §B.2) — rendered by
 * both `app/onboarding/taste/page.tsx` (onboarding mode) and
 * `app/setup/travel-dna/page.tsx` (edit mode, via Profile's `?edit=1`
 * link), so the two never drift again. Replaces the old three sliders
 * (`luxury_backpacker`/`planned_spontaneous`/`foodie_utilitarian`) with
 * banded controls that map straight onto `travel_preferences`' new Phase 4
 * columns (supabase/add_person_persona.sql) — see the plan §C.2 note that
 * "a band maps straight to price_level" where a slider parked at 3 didn't.
 * Since there's no slider left in this form at all, the "inverted slider
 * labels between the two screens" bug the plan calls out simply has
 * nothing left to carry forward.
 *
 * This form does NOT touch `mobility` (the old free-text chips) — that's
 * legacy, backfilled into `walk_tolerance` in a later phase per plan §C.2,
 * not read or written here.
 */
export type BudgetBand = "shoestring" | "middle" | "treat";
export type WalkTolerance = "high" | "medium" | "low";

const BUDGET_OPTIONS: SegmentOption<BudgetBand>[] = [
  { value: "shoestring", label: "Shoestring" },
  { value: "middle", label: "Middle" },
  { value: "treat", label: "Treat" },
];

const WALK_OPTIONS: SegmentOption<WalkTolerance>[] = [
  { value: "high", label: "Happy to walk" },
  { value: "medium", label: "Moderate" },
  { value: "low", label: "Keep it short" },
];

function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export interface TasteFormProps {
  mode: "onboarding" | "edit";
  /** Called after a successful save. The caller decides where to navigate. */
  onSaved: () => void;
}

export function TasteForm({ mode, onSaved }: TasteFormProps) {
  const db = supabaseBrowserAuth();

  const [budgetBand, setBudgetBand] = useState<BudgetBand | null>(null);
  const [interestTags, setInterestTags] = useState<InterestTag[]>([]);
  const [dietary, setDietary] = useState<string[]>([]);
  const [walkTolerance, setWalkTolerance] = useState<WalkTolerance | null>(null);
  const [languages, setLanguages] = useState<string[]>(["English"]);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Preload existing prefs — always (edit mode reopens with saved values;
  // onboarding mode preloads too, harmless if there's nothing saved yet, and
  // means going back a step and returning doesn't lose earlier taps).
  useEffect(() => {
    let cancelled = false;
    getPreferences(db).then((prefs) => {
      if (cancelled || !prefs) return;
      if (prefs.budget_band) setBudgetBand(prefs.budget_band as BudgetBand);
      if (prefs.interest_tags?.length) setInterestTags(prefs.interest_tags as InterestTag[]);
      if (prefs.dietary?.length) setDietary(prefs.dietary);
      if (prefs.walk_tolerance) setWalkTolerance(prefs.walk_tolerance as WalkTolerance);
      if (prefs.languages?.length) setLanguages(prefs.languages);
    });
    return () => {
      cancelled = true;
    };
  }, [db]);

  function toggleLanguage(value: string) {
    setLanguages((prev) => toggleValue(prev, value));
  }

  function removeLanguage(value: string) {
    setLanguages((prev) => prev.filter((v) => v !== value));
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      await upsertPreferences(db, {
        budget_band: budgetBand,
        interest_tags: interestTags,
        dietary,
        walk_tolerance: walkTolerance,
        languages,
      });
      onSaved();
    } catch (err) {
      console.error("[TasteForm] save failed", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-headline-md text-on-surface">Your taste</h1>
        <p className="text-body-md text-on-surface-variant">
          A few things that make a day feel right for you.
        </p>
      </header>

      {/* Budget */}
      <section className="flex flex-col gap-3">
        <h2 className="text-label-lg font-semibold text-on-surface">Budget</h2>
        <SegmentedControl
          value={budgetBand ?? "middle"}
          options={BUDGET_OPTIONS}
          onChange={setBudgetBand}
          className="w-full"
        />
      </section>

      {/* Interests */}
      <section className="flex flex-col gap-3">
        <h2 className="text-label-lg font-semibold text-on-surface">Interests</h2>
        <div className="flex flex-wrap gap-2">
          {INTEREST_TAGS.map((tag) => (
            <Chip
              key={tag}
              label={INTEREST_TAG_META[tag].label}
              leadingIcon={INTEREST_TAG_META[tag].icon}
              selected={interestTags.includes(tag)}
              onClick={() => setInterestTags((prev) => toggleValue(prev, tag))}
            />
          ))}
        </div>
      </section>

      {/* Dietary */}
      <section className="flex flex-col gap-3">
        <h2 className="text-label-lg font-semibold text-on-surface">Dietary</h2>
        <div className="flex flex-wrap gap-2">
          {DIETARY_OPTIONS.map((label) => (
            <Chip
              key={label}
              label={label}
              selected={dietary.includes(label)}
              onClick={() => setDietary((prev) => toggleValue(prev, label))}
            />
          ))}
        </div>
      </section>

      {/* Walking */}
      <section className="flex flex-col gap-3">
        <h2 className="text-label-lg font-semibold text-on-surface">Walking</h2>
        <SegmentedControl
          value={walkTolerance ?? "medium"}
          options={WALK_OPTIONS}
          onChange={setWalkTolerance}
          className="w-full"
        />
      </section>

      {/* Languages */}
      <section className="flex flex-col gap-2">
        <h2 className="text-label-lg font-semibold text-on-surface">Languages I speak</h2>
        <div className="flex min-h-[56px] flex-wrap items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest p-3">
          {languages.map((lang) => (
            <span
              key={lang}
              className="flex items-center gap-1 rounded-full bg-surface-container-high px-3 py-1.5 text-label-sm text-on-surface"
            >
              {lang}
              <button
                type="button"
                aria-label={`Remove ${lang}`}
                onClick={() => removeLanguage(lang)}
                className="flex h-4 w-4 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-variant"
              >
                <Icon name="close" size={14} />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => setLanguagePickerOpen(true)}
            className="flex items-center gap-1 rounded-full border border-dashed border-outline-variant px-3 py-1.5 text-label-sm text-on-surface-variant transition-colors hover:bg-surface-container-high"
          >
            <Icon name="add" size={16} />
            Add language
          </button>
        </div>
      </section>

      <LanguagesMultiPicker
        open={languagePickerOpen}
        onClose={() => setLanguagePickerOpen(false)}
        selected={languages}
        onToggle={toggleLanguage}
      />

      <Button
        variant="orange"
        fullWidth
        size="md"
        trailingIcon={mode === "onboarding" ? "arrow_forward" : undefined}
        disabled={saving}
        onClick={() => void handleSave()}
      >
        {saving ? "Saving…" : mode === "onboarding" ? "Continue" : "Save"}
      </Button>
    </div>
  );
}

export default TasteForm;
