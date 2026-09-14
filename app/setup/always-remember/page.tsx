"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Chip, PageHeader, Textarea } from "@/components/ui";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { getRules, upsertRules } from "@/lib/db";

// Exact quick-addition chip copy from always_remember/code.html.
const QUICK_ADDITIONS = [
  "Always check opening hours",
  "Avoid outdoor plans if rain",
  "Prefer hidden local spots",
  "Counter seats over booths",
];

function AlwaysRememberForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const db = supabaseBrowserAuth();
  const isEdit = searchParams.get("edit") === "1" || searchParams.get("from") === "profile";

  const [rulesText, setRulesText] = useState("");
  const [quickChips, setQuickChips] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getRules(db).then((rules) => {
      if (cancelled || !rules) return;
      if (rules.rules_text) setRulesText(rules.rules_text);
      if (rules.quick_chips?.length) setQuickChips(rules.quick_chips);
    });
    return () => {
      cancelled = true;
    };
  }, [db]);

  function appendQuickAddition(text: string) {
    setQuickChips((prev) => (prev.includes(text) ? prev : [...prev, text]));
    setRulesText((prev) => {
      if (!prev.trim()) return text;
      if (prev.includes(text)) return prev;
      return `${prev.replace(/\s+$/, "")}\n${text}`;
    });
  }

  async function finish(persistRules: boolean) {
    if (saving) return;
    setSaving(true);
    try {
      if (persistRules) {
        await upsertRules(db, { rules_text: rulesText, quick_chips: quickChips });
      }
      // No auto-seeded demo trip anymore — new travelers land on Home's empty
      // state (or already have a trip from the calendar-detected setup step),
      // and create their real first trip from there.
      router.push(isEdit ? "/profile" : "/");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-dvh w-full flex-col bg-background">
      <PageHeader
        showBack
        action={
          !isEdit ? (
            <button
              type="button"
              onClick={() => finish(false)}
              className="flex min-h-[40px] items-center justify-center rounded-full px-4 text-label-md text-on-surface-variant transition-colors hover:text-primary"
            >
              Skip
            </button>
          ) : undefined
        }
      />

      {/* Progress: step 3 of 3 */}
      <div className="mx-auto flex w-full max-w-md flex-col gap-2 px-5 py-4">
        <div className="flex items-center justify-between text-label-sm text-on-surface-variant">
          <span>Step 3 of 3</span>
          <span>Final Details</span>
        </div>
        <div className="flex h-1.5 w-full gap-2 overflow-hidden rounded-full bg-outline-variant">
          <div className="h-full w-full rounded-full bg-primary opacity-30" />
          <div className="h-full w-full rounded-full bg-primary opacity-30" />
          <div className="h-full w-full rounded-full bg-primary" />
        </div>
      </div>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-8 px-5 pt-4 pb-12">
        <div className="flex flex-col gap-4">
          <h1 className="text-headline-lg-mobile text-primary">Always Remember</h1>
          <p className="text-body-lg text-on-surface-variant">
            Tell Fomo about your travel preferences, dietary restrictions, or
            anything else you want applied to all your future itineraries.
          </p>
        </div>

        <Textarea
          id="rules-input"
          label="Your General Rules"
          value={rulesText}
          onChange={(e) => setRulesText(e.target.value)}
          rows={7}
          placeholder="e.g., I'm allergic to shellfish. I prefer direct flights. I always need a late checkout. I travel with a small dog."
        />

        <div className="flex flex-col gap-4">
          <span className="text-label-sm uppercase tracking-wider text-outline">
            Quick Additions
          </span>
          <div className="flex flex-wrap gap-3">
            {QUICK_ADDITIONS.map((text) => (
              <Chip
                key={text}
                label={text}
                leadingIcon="add"
                onClick={() => appendQuickAddition(text)}
              />
            ))}
          </div>
        </div>
      </main>

      <div className="mx-auto w-full max-w-md px-5 pb-8 pt-4">
        <Button
          variant="orange"
          fullWidth
          size="md"
          disabled={saving}
          onClick={() => finish(true)}
          className="h-14 text-headline-sm"
        >
          Done
        </Button>
      </div>
    </div>
  );
}

export default function AlwaysRememberPage() {
  return (
    <Suspense fallback={null}>
      <AlwaysRememberForm />
    </Suspense>
  );
}
