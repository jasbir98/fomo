"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Chip, Icon, PageHeader, ProgressBar, Slider } from "@/components/ui";
import { LanguagesMultiPicker } from "@/components/roameo/LanguagesMultiPicker";
import { useDeviceId } from "@/lib/device";
import { getPreferences, upsertPreferences } from "@/lib/db";
import { INTERESTS } from "@/lib/interests";

const DIETARY = ["Vegan", "Gluten Free", "Vegetarian", "Halal"] as const;

const MOBILITY = ["Wheelchair Accessible", "Low Walking", "No Stairs"] as const;

function toggleValue(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function TravelDnaForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const deviceId = useDeviceId();
  const isEdit = searchParams.get("edit") === "1" || searchParams.get("from") === "profile";

  const [luxuryBackpacker, setLuxuryBackpacker] = useState(3);
  const [plannedSpontaneous, setPlannedSpontaneous] = useState(3);
  const [foodieUtilitarian, setFoodieUtilitarian] = useState(3);
  const [interests, setInterests] = useState<string[]>([]);
  const [dietary, setDietary] = useState<string[]>([]);
  const [mobility, setMobility] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>(["English"]);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Preload existing prefs (edit mode reopens with saved values; harmless if
  // there's nothing saved yet during first-run onboarding).
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    getPreferences(deviceId).then((prefs) => {
      if (cancelled || !prefs) return;
      if (prefs.luxury_backpacker != null) setLuxuryBackpacker(prefs.luxury_backpacker);
      if (prefs.planned_spontaneous != null) setPlannedSpontaneous(prefs.planned_spontaneous);
      if (prefs.foodie_utilitarian != null) setFoodieUtilitarian(prefs.foodie_utilitarian);
      if (prefs.interests?.length) setInterests(prefs.interests);
      if (prefs.dietary?.length) setDietary(prefs.dietary);
      if (prefs.mobility?.length) setMobility(prefs.mobility);
      if (prefs.languages?.length) setLanguages(prefs.languages);
    });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  function toggleLanguage(value: string) {
    setLanguages((prev) => toggleValue(prev, value));
  }

  function removeLanguage(value: string) {
    setLanguages((prev) => prev.filter((v) => v !== value));
  }

  async function handleContinue() {
    if (!deviceId || saving) return;
    setSaving(true);
    try {
      await upsertPreferences(deviceId, {
        luxury_backpacker: luxuryBackpacker,
        planned_spontaneous: plannedSpontaneous,
        foodie_utilitarian: foodieUtilitarian,
        interests,
        dietary,
        mobility,
        languages,
      });
      if (isEdit) {
        router.push("/profile");
      } else {
        router.push("/setup/always-remember");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-dvh w-full flex-col bg-background pb-32">
      <PageHeader showBack={isEdit} />
      <div className="px-5">
        <ProgressBar value={66} tone="navy" label="Setup progress" />
      </div>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-8 px-5 pt-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-headline-lg-mobile text-primary">Your Travel DNA</h1>
          <p className="text-body-md text-on-surface-variant">
            Tell us what makes a perfect trip for you. Roameo will use this to craft
            personalized itineraries.
          </p>
        </header>

        {/* The Vibe: sliders */}
        <section className="flex flex-col gap-4">
          <h2 className="text-headline-sm text-primary">The Vibe</h2>
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4 shadow-sm">
              <Slider
                value={luxuryBackpacker}
                onChange={setLuxuryBackpacker}
                leftLabel="Luxury"
                rightLabel="Backpacker"
                aria-label="Luxury to Backpacker preference"
              />
            </div>
            <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4 shadow-sm">
              <Slider
                value={plannedSpontaneous}
                onChange={setPlannedSpontaneous}
                leftLabel="Planned"
                rightLabel="Spontaneous"
                aria-label="Planned to Spontaneous preference"
              />
            </div>
            <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4 shadow-sm">
              <Slider
                value={foodieUtilitarian}
                onChange={setFoodieUtilitarian}
                leftLabel="Foodie"
                rightLabel="Utilitarian"
                aria-label="Foodie to Utilitarian preference"
              />
            </div>
          </div>
        </section>

        {/* Interests */}
        <section className="flex flex-col gap-4">
          <h2 className="text-headline-sm text-primary">Interests</h2>
          <div className="flex flex-wrap gap-3">
            {INTERESTS.map((opt) => (
              <Chip
                key={opt.label}
                label={opt.label}
                leadingIcon={opt.icon}
                selected={interests.includes(opt.label)}
                onClick={() => setInterests((prev) => toggleValue(prev, opt.label))}
              />
            ))}
          </div>
        </section>

        {/* Dietary + Mobility */}
        <section className="grid grid-cols-1 gap-4">
          <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4 shadow-sm">
            <h3 className="mb-4 flex items-center gap-2 text-label-md text-on-surface-variant">
              <Icon name="restaurant" size={20} />
              Dietary Needs
            </h3>
            <div className="flex flex-wrap gap-2">
              {DIETARY.map((label) => (
                <Chip
                  key={label}
                  label={label}
                  selected={dietary.includes(label)}
                  onClick={() => setDietary((prev) => toggleValue(prev, label))}
                />
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4 shadow-sm">
            <h3 className="mb-4 flex items-center gap-2 text-label-md text-on-surface-variant">
              <Icon name="accessible_forward" size={20} />
              Mobility Constraints
            </h3>
            <div className="flex flex-wrap gap-2">
              {MOBILITY.map((label) => (
                <Chip
                  key={label}
                  label={label}
                  selected={mobility.includes(label)}
                  onClick={() => setMobility((prev) => toggleValue(prev, label))}
                />
              ))}
            </div>
          </div>
        </section>

        {/* Languages: validated multi-select via LanguagesMultiPicker */}
        <section className="flex flex-col gap-2">
          <label className="text-label-md text-on-surface-variant">Languages I speak</label>
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
      </main>

      <LanguagesMultiPicker
        open={languagePickerOpen}
        onClose={() => setLanguagePickerOpen(false)}
        selected={languages}
        onToggle={toggleLanguage}
      />

      {/* Fixed bottom action */}
      <div className="fixed bottom-0 left-0 z-40 w-full bg-gradient-to-t from-background via-background to-transparent px-5 pb-6 pt-10">
        <div className="mx-auto w-full max-w-md">
          <Button
            variant="orange"
            fullWidth
            trailingIcon="arrow_forward"
            disabled={!deviceId || saving}
            onClick={handleContinue}
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function TravelDnaPage() {
  return (
    <Suspense fallback={null}>
      <TravelDnaForm />
    </Suspense>
  );
}
