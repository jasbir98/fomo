"use client";

import { useState } from "react";
import { BottomSheet, Button, Chip, SegmentedControl } from "@/components/ui";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { INTEREST_ICON, INTEREST_LABEL, INTEREST_ORDER, MAX_INTERESTS, type InterestKey } from "@/lib/personalise/interests";
import { usePrefs, type FomoBudget, type FomoStatus } from "@/lib/personalise/usePrefs";
import { track } from "@/lib/analytics/track";
import { sendToSignIn } from "@/lib/auth/send-to-signin";

export interface MakeFomoYoursProps {
  open: boolean;
  onClose: () => void;
}

const STATUS_OPTIONS: { value: FomoStatus; label: string }[] = [
  { value: "student", label: "Student" },
  { value: "working", label: "Working" },
  { value: "other", label: "Neither" },
];

const BUDGET_OPTIONS: { value: FomoBudget; label: string }[] = [
  { value: "free", label: "Free only" },
  { value: "under10", label: "Under £10" },
  { value: "any", label: "Anything" },
];

/**
 * "Make Fomo yours" — the one card that replaces Profile's old 4-chip "Deals
 * for you" selector (task brief). One scrollable sheet, not a wizard: status
 * → two yes/no toggles (+ Over 60 under "More") → up to 5 interest chips →
 * budget → Save / Skip for now. Reused for all three triggers (first save,
 * Home's dismissible banner, and Profile's own "Edit") — same component,
 * same state shape (lib/personalise/usePrefs.ts), so there's exactly one
 * place this could ever get out of sync with itself.
 *
 * Open to everyone, but personalisation needs an account: signed out, Save
 * keeps the answers locally (they carry over and merge into the account on
 * sign-in, see usePrefs.ts) and then sends the visitor to sign in, landing
 * on /for-you. The sheet seeds from `prefs.draft` (what they have picked so
 * far) because `prefs` itself is neutral while signed out.
 *
 * Edits are staged in local state and only committed via `prefs.save()` on
 * Save — Cancel/Esc/backdrop (BottomSheet's own `onClose`) discards them,
 * same as every other edit sheet in the app never auto-saves keystrokes.
 */
export function MakeFomoYours({ open, onClose }: MakeFomoYoursProps) {
  const prefs = usePrefs();
  const draft = prefs.draft;
  const signedOut = prefs.signedIn === false;
  // `null` (never answered) is a real, distinct third state from "other" —
  // starting it pre-selected on "Neither" reads as a claim about someone who
  // hasn't said anything yet, so the segmented control starts with no
  // segment active until they actually pick one. Save is still allowed with
  // this left `null` (§2's own "Save still allowed with nothing chosen") —
  // `FomoPrefs.status` is already `FomoStatus | null`, so nothing downstream
  // needs to special-case it.
  const [status, setStatus] = useState<FomoStatus | null>(draft.status);
  const [under26, setUnder26] = useState(draft.under26);
  const [residents, setResidents] = useState(draft.residents);
  const [over60, setOver60] = useState(draft.over60);
  const [showMore, setShowMore] = useState(draft.over60);
  const [interests, setInterests] = useState<InterestKey[]>(draft.interests);
  const [budget, setBudget] = useState<FomoBudget>(draft.budget);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-seed the local edit state from whatever's currently saved every time
  // the sheet transitions closed→open — it stays mounted (portaled) between
  // opens, so without this a second open (Profile's "Edit", after Save
  // already changed `prefs`) would show stale local state from the first.
  // Adjusted during render (React's own pattern for "state depends on a
  // prop change") rather than in an effect, which would set state
  // synchronously right after the initial render and trigger an extra one.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStatus(draft.status);
      setUnder26(draft.under26);
      setResidents(draft.residents);
      setOver60(draft.over60);
      setShowMore(draft.over60);
      setInterests(draft.interests);
      setBudget(draft.budget);
      setError(null);
    }
  }

  function toggleInterest(key: InterestKey) {
    setInterests((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= MAX_INTERESTS) return prev;
      return [...prev, key];
    });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await prefs.save({ status, under26, residents, over60, interests, budget, done: true });
      track("prefs_completed");
      onClose();
      // Saved locally above; the picks only take effect once they have an
      // account, so hand off to sign-in and bring them to their picks.
      if (signedOut) sendToSignIn("personalise", "/for-you");
    } catch (err) {
      console.error("[personalise] save prefs failed", err);
      setError("Couldn't save that. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSkip() {
    setSaving(true);
    try {
      await prefs.dismiss();
      track("prefs_skipped");
    } catch (err) {
      console.error("[personalise] dismiss prefs failed", err);
    } finally {
      setSaving(false);
      onClose();
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Make Fomo yours" ariaLabel="Make Fomo yours">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <FomoSpot mood="grin" pose="wave" className="h-14 w-14" />
          <p className="text-body-sm text-on-surface-variant">
            A few quick picks so Fomo can flag deals you actually qualify for and put your kind of thing first.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-label-md font-bold text-on-surface" id="mfy-status-label">
            I&apos;m a…
          </label>
          {/* SegmentedControl (components/ui/SegmentedControl.tsx) has no
              built-in "nothing selected" state — its sliding indicator only
              ever tracks one of `options`. Passing a value that matches none
              of them (cast, since its own type requires a real option value)
              is what keeps it exactly there: no segment reads as active
              until the visitor taps one, which is the point (see `status`'s
              own doc comment above). */}
          <SegmentedControl
            value={(status ?? "") as FomoStatus}
            options={STATUS_OPTIONS}
            onChange={setStatus}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Chip
            label="Under 26?"
            selected={under26}
            leadingIcon={under26 ? "check" : undefined}
            aria-pressed={under26}
            className="min-h-[44px]"
            onClick={() => setUnder26((v) => !v)}
          />
          <Chip
            label="EH postcode?"
            selected={residents}
            leadingIcon={residents ? "check" : undefined}
            aria-pressed={residents}
            className="min-h-[44px]"
            onClick={() => setResidents((v) => !v)}
          />
        </div>

        {showMore ? (
          <Chip
            label="Over 60?"
            selected={over60}
            leadingIcon={over60 ? "check" : undefined}
            aria-pressed={over60}
            className="min-h-[44px] w-fit"
            onClick={() => setOver60((v) => !v)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowMore(true)}
            className="w-fit min-h-[44px] text-label-sm font-semibold text-primary underline underline-offset-2"
          >
            More
          </button>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-label-md font-bold text-on-surface" id="mfy-interests-label">
              Into…
            </label>
            <span className="text-label-sm text-on-surface-variant">
              {interests.length}/{MAX_INTERESTS}
            </span>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="mfy-interests-label">
            {INTEREST_ORDER.map((key) => {
              const selected = interests.includes(key);
              const disabled = !selected && interests.length >= MAX_INTERESTS;
              return (
                <Chip
                  key={key}
                  label={INTEREST_LABEL[key]}
                  leadingIcon={INTEREST_ICON[key]}
                  selected={selected}
                  disabled={disabled}
                  aria-pressed={selected}
                  className="min-h-[44px] disabled:opacity-40"
                  onClick={() => toggleInterest(key)}
                />
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-label-md font-bold text-on-surface" id="mfy-budget-label">
            Budget
          </label>
          <SegmentedControl value={budget} options={BUDGET_OPTIONS} onChange={setBudget} />
        </div>

        {error ? <p className="text-label-sm text-error">{error}</p> : null}

        {/* Sticky footer: on short phones the sheet body scrolls, and Save/Skip
            must stay reachable. The negative bottom margin cancels the sheet
            body's own bottom padding so the footer owns the safe-area gap.
            z-20 keeps it above the budget control's z-10 labels as they scroll under. */}
        <div className="sticky bottom-[calc(-1rem-env(safe-area-inset-bottom))] z-20 -mx-4 -mb-[calc(1rem+env(safe-area-inset-bottom))] flex items-center gap-3 border-t border-hairline bg-surface-container-lowest px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] lg:-bottom-6 lg:-mx-6 lg:-mb-6 lg:px-6 lg:pb-6">
          <Button variant="ghost" onClick={handleSkip} disabled={saving} className="flex-1">
            Skip for now
          </Button>
          <Button variant="navy" onClick={handleSave} disabled={saving} className="flex-1">
            {signedOut ? "Sign in to see your picks" : "Save"}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

export default MakeFomoYours;
