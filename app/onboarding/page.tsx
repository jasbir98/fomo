"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Icon, Input } from "@/components/ui";
import { useDeviceId } from "@/lib/device";
import { createTrip, setActiveTrip } from "@/lib/db";
import type { PlaceSuggestion } from "@/lib/places/geocode";

/**
 * Roameo v1 onboarding (plan-v1-home-pivot.md §3) — one screen, two
 * questions: where, and when. Everything that used to gate the app before
 * it did anything useful — 3 intro slides, a mock calendar connect, a
 * separate "trip detected" screen, and the Travel DNA form — is cut from
 * this flow entirely. Travel DNA moved to Profile (optional, reachable via
 * `/setup/travel-dna?edit=1`); the cold-start Home hero (app/(shell)/page.tsx)
 * now does the "here's what Roameo can do" job the old slides did, but with
 * real, useful content instead of a pitch.
 */
function defaultTripName(destination: string): string {
  const primary = destination.split(",")[0]?.trim();
  return primary ? `Trip to ${primary}` : "New trip";
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function OnboardingPage() {
  const router = useRouter();
  const deviceId = useDeviceId();

  const [destination, setDestination] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const justPickedRef = useRef(false);

  useEffect(() => {
    const q = destination.trim();
    if (justPickedRef.current) {
      justPickedRef.current = false;
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      if (q.length < 2) {
        if (!cancelled) setSuggestions([]);
        return;
      }
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        const data = (await res.json()) as { suggestions?: PlaceSuggestion[] };
        if (cancelled) return;
        setSuggestions(data.suggestions ?? []);
        setShowSuggestions(true);
      } catch {
        if (!cancelled) setSuggestions([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [destination]);

  function pickSuggestion(s: PlaceSuggestion) {
    justPickedRef.current = true;
    setDestination(s.name);
    setSuggestions([]);
    setShowSuggestions(false);
  }

  async function finish(opts: { alreadyThere: boolean }) {
    if (!deviceId || saving) return;
    const dest = destination.trim();
    if (!dest) {
      setError("Where are you headed?");
      return;
    }

    const start = opts.alreadyThere ? todayISODate() : startDate;
    if (!start || (!opts.alreadyThere && !endDate)) {
      setError("Add when you're going — or just say you're already there.");
      return;
    }
    const end = opts.alreadyThere ? endDate || start : endDate;
    if (end && end < start) {
      setError("The end date can't be before the start date.");
      return;
    }

    setError(null);
    setSaving(true);
    try {
      const trip = await createTrip(deviceId, {
        name: defaultTripName(dest),
        destination: dest,
        start_date: start,
        end_date: end || start,
        status: "active",
      });
      await setActiveTrip(deviceId, trip.id);
      router.replace("/");
    } catch (err) {
      console.error("[onboarding] create trip failed", err);
      setError("Couldn't set that up. Try again.");
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-dvh w-full flex-col bg-background px-6 pt-safe pb-safe">
      <div className="flex items-center justify-center gap-2 pt-10 pb-8">
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="10" className="fill-primary" />
          <path
            d="M0 10C0 15.5228 4.47715 20 10 20C15.5228 20 20 15.5228 20 10H0Z"
            className="fill-secondary-container"
          />
        </svg>
        <span className="text-headline-sm text-on-surface">
          Roameo<span className="text-secondary-container">.</span>
        </span>
      </div>

      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 pb-10">
        <div className="text-center">
          <h1 className="mb-2 text-headline-md text-on-surface">Where are you going?</h1>
          <p className="text-body-md text-on-surface-variant">
            That&rsquo;s all we need to start. Everything else, I&rsquo;ll figure out as we go.
          </p>
        </div>

        <div className="relative flex flex-col gap-1.5">
          <Input
            label="Destination"
            leadingIcon="location_on"
            value={destination}
            onChange={(e) => {
              setDestination(e.target.value);
              setError(null);
            }}
            onFocus={() => {
              if (suggestions.length > 0) setShowSuggestions(true);
            }}
            placeholder="e.g. Kyoto, Japan"
            autoComplete="off"
          />
          {showSuggestions && suggestions.length > 0 ? (
            <ul className="absolute top-full z-20 mt-1 w-full overflow-hidden rounded-md border border-outline-variant bg-surface-container-lowest shadow-lg">
              {suggestions.map((s) => (
                <li key={`${s.name}-${s.lat}-${s.lng}`}>
                  <button
                    type="button"
                    onClick={() => pickSuggestion(s)}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-body-md text-on-surface transition-colors hover:bg-surface-container-low"
                  >
                    <Icon name="place" size={18} className="shrink-0 text-on-surface-variant" />
                    <span className="truncate">{s.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="From"
            type="date"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              setError(null);
            }}
          />
          <Input
            label="To"
            type="date"
            value={endDate}
            onChange={(e) => {
              setEndDate(e.target.value);
              setError(null);
            }}
          />
        </div>

        {error ? <p className="text-center text-label-md text-error">{error}</p> : null}

        <div className="flex flex-col gap-3 pt-2">
          <Button variant="orange" fullWidth size="md" onClick={() => void finish({ alreadyThere: false })} disabled={saving}>
            {saving ? "Setting up…" : "Let's go"}
          </Button>
          <button
            type="button"
            onClick={() => void finish({ alreadyThere: true })}
            disabled={saving}
            className="text-center text-label-md font-semibold text-primary underline-offset-2 hover:underline disabled:opacity-50"
          >
            I&rsquo;m already there
          </button>
        </div>
      </main>
    </div>
  );
}
