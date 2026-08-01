"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Icon, Input, PageHeader } from "@/components/ui";
import { useDeviceId } from "@/lib/device";
import { createTrip, setActiveTrip } from "@/lib/db";
import type { PlaceSuggestion } from "@/lib/places/geocode";

/** Default name when the traveler leaves the name blank: "Trip to Kyoto". */
function defaultTripName(destination: string): string {
  const primary = destination.split(",")[0]?.trim();
  return primary ? `Trip to ${primary}` : "New trip";
}

export default function NewTripPage() {
  const router = useRouter();
  const deviceId = useDeviceId();

  const [destination, setDestination] = useState("");
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [coverUrl, setCoverUrl] = useState("");

  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Set true right after picking a suggestion so the ensuing value change
  // doesn't immediately re-open the dropdown.
  const justPickedRef = useRef(false);

  // Debounced destination autocomplete via /api/geocode.
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

  async function handleCreate() {
    if (saving) return;
    const dest = destination.trim();
    if (!deviceId) return;
    if (!dest) {
      setError("Where are you headed? Add a destination.");
      return;
    }
    if (!startDate || !endDate) {
      setError("Add both a start and end date.");
      return;
    }
    if (endDate < startDate) {
      setError("The end date can't be before the start date.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const trip = await createTrip(deviceId, {
        name: name.trim() || defaultTripName(dest),
        destination: dest,
        start_date: startDate,
        end_date: endDate,
        status: "active",
        cover_image_url: coverUrl.trim() || null,
      });
      // createTrip sets this trip active; setActiveTrip also deactivates the rest.
      await setActiveTrip(deviceId, trip.id);
      router.replace("/");
    } catch (err) {
      console.error("[new-trip] create failed", err);
      setError("Couldn't create the trip. Please try again.");
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-dvh w-full flex-col bg-background">
      <PageHeader showBack title="New trip" />

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-5 pt-4 pb-32">
        <p className="text-body-lg text-on-surface-variant">
          Tell Roameo where and when you&rsquo;re going. You can fine-tune the
          details later.
        </p>

        {/* Destination with autocomplete */}
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

        <Input
          label="Trip name (optional)"
          leadingIcon="luggage"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={destination.trim() ? defaultTripName(destination) : "e.g. Spring in Japan"}
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Start date"
            type="date"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              setError(null);
            }}
          />
          <Input
            label="End date"
            type="date"
            value={endDate}
            min={startDate || undefined}
            onChange={(e) => {
              setEndDate(e.target.value);
              setError(null);
            }}
          />
        </div>

        <Input
          label="Cover image URL (optional)"
          leadingIcon="image"
          value={coverUrl}
          onChange={(e) => setCoverUrl(e.target.value)}
          placeholder="https://images.unsplash.com/..."
          helperText="Paste an image link, or leave blank for a default cover."
        />

        {error ? (
          <p className="flex items-center gap-1.5 text-label-md font-medium text-error">
            <Icon name="error" size={18} />
            {error}
          </p>
        ) : null}
      </main>

      <div className="fixed bottom-0 left-1/2 z-10 w-full max-w-[480px] -translate-x-1/2 border-t border-outline-variant bg-background/90 px-5 py-5 pb-safe backdrop-blur-md">
        <Button
          variant="orange"
          fullWidth
          leadingIcon="check"
          disabled={!deviceId || saving}
          onClick={handleCreate}
        >
          {saving ? "Creating…" : "Create trip"}
        </Button>
      </div>
    </div>
  );
}
