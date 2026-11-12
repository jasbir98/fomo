"use client";

import { useId, useState } from "react";
import { Chip, Icon } from "@/components/ui";
import { usePrefs, type FomoPrefs } from "@/lib/personalise/usePrefs";
import { openMakeFomoYours } from "@/lib/personalise/trigger";
import { track } from "@/lib/analytics/track";

type AudienceField = "student" | "under26" | "residents";

const CHIPS: { field: AudienceField; label: string }[] = [
  { field: "student", label: "Student" },
  { field: "under26", label: "Under 26" },
  { field: "residents", label: "EH postcode" },
];

/** `fomo_who` group names, so the analytics dimension matches the rest of the app's `who_groups`. */
const GROUP_FOR_FIELD: Record<AudienceField, string> = {
  student: "students",
  under26: "under_26",
  residents: "residents",
};

function isOn(prefs: FomoPrefs, field: AudienceField): boolean {
  if (field === "student") return prefs.status === "student";
  return prefs[field];
}

/** Plain-words labels for the collapsed summary, in chip order, plus the sheet-only answers. */
export function audienceLabels(prefs: FomoPrefs): string[] {
  const out: string[] = [];
  if (prefs.status === "student") out.push("Student");
  if (prefs.under26) out.push("Under 26");
  if (prefs.residents) out.push("EH postcode");
  if (prefs.over60) out.push("Over 60");
  if (prefs.kids) out.push("Kids");
  return out;
}

/**
 * Home's inline "who are you" ask, right under the page intro: three toggle
 * chips (Student, Under 26, EH postcode) that write the same prefs the Make
 * Fomo yours sheet edits (lib/personalise/usePrefs.ts: `status`, `under26`,
 * `residents`). Works signed out: the answers live on this device and feed
 * "You qualify" badges and ranking straight away (see useEffectiveWho), and
 * merge into the account on sign-in if it has none yet. Signed in, they save
 * to the account like the sheet does.
 *
 * Once anything is set the row collapses to a one-line summary with Edit.
 * While the visitor is tapping chips it stays open (so a second chip is one
 * tap, not Edit + tap) until they press Done or come back later. "More"
 * opens the full sheet for the longer questions (interests, budget, kids).
 *
 * Deliberately does NOT set `done`: that flag gates the first-save sheet
 * prompt, which is still the place the taste questions get asked.
 *
 * SSR/hydration: `usePrefs` has a default server snapshot, so the server and
 * first client render both show the open chip row; a returning visitor's
 * summary appears right after hydration.
 */
export function AudienceAsk({ className = "" }: { className?: string }) {
  const prefs = usePrefs();
  const draft = prefs.draft;
  const labelId = useId();
  const [editing, setEditing] = useState(false);
  const labels = audienceLabels(draft);
  const collapsed = labels.length > 0 && !editing;

  async function toggle(field: AudienceField) {
    const on = !isOn(draft, field);
    const next: FomoPrefs =
      field === "student"
        ? { ...draft, status: on ? "student" : draft.status === "student" ? null : draft.status }
        : { ...draft, [field]: on };
    setEditing(true);
    track("audience_pref_set", { group: GROUP_FOR_FIELD[field], on, surface: "home", signed_in: prefs.signedIn === true });
    try {
      await prefs.save(next);
    } catch (err) {
      // savePrefs already reverted the optimistic write; the chip flips back.
      console.error("[personalise] audience ask save failed", err);
    }
  }

  function openSheet() {
    track("home_prefs_opened");
    openMakeFomoYours();
  }

  if (collapsed) {
    return (
      <div className={`flex min-h-9 items-center gap-2 px-1 ${className}`}>
        <Icon name="check_circle" size={16} className="shrink-0 text-secondary" filled />
        <p className="min-w-0 flex-1 truncate text-label-md text-on-surface-variant">
          Flagging deals for <span className="font-semibold text-on-surface">{labels.join(", ")}</span>
        </p>
        <button
          type="button"
          onClick={() => {
            track("audience_ask_edit_opened");
            setEditing(true);
          }}
          className="flex min-h-9 shrink-0 items-center gap-0.5 rounded-full px-2 text-label-md font-semibold text-primary hover:bg-surface-container-low"
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <div className="flex min-h-5 items-center justify-between gap-2 px-1">
        <p id={labelId} className="min-w-0 text-label-sm text-on-surface-variant">
          Tap what fits and we&rsquo;ll flag deals you qualify for
        </p>
        {editing && labels.length > 0 ? (
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="-my-2 flex min-h-9 shrink-0 items-center rounded-full px-2 text-label-md font-semibold text-primary hover:bg-surface-container-low"
          >
            Done
          </button>
        ) : null}
      </div>
      <div
        role="group"
        aria-labelledby={labelId}
        className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:px-0 [&::-webkit-scrollbar]:hidden"
      >
        {CHIPS.map(({ field, label }) => {
          const on = isOn(draft, field);
          return (
            <Chip
              key={field}
              label={label}
              selected={on}
              leadingIcon={on ? "check" : undefined}
              className="shrink-0 px-3"
              onClick={() => void toggle(field)}
            />
          );
        })}
        <button
          type="button"
          onClick={openSheet}
          className="flex min-h-9 shrink-0 items-center gap-0.5 rounded-full px-2.5 text-label-md font-semibold text-primary hover:bg-surface-container-low"
        >
          More
          <Icon name="chevron_right" size={16} />
        </button>
      </div>
    </div>
  );
}

export default AudienceAsk;
