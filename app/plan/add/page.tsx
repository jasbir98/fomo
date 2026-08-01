"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useDeviceId } from "@/lib/device";
import { createItem, getCurrentTrip } from "@/lib/db";
import type { Place, Trip } from "@/lib/types";
import { BottomSheet, Button, Icon, Textarea } from "@/components/ui";

/**
 * Source: `add_item_menu/code.html`, rebuilt for plan-v1.1-overhaul.md W4 #7
 * — the original was a full page styled to *look* like a sheet, with 3 of
 * its 4 tiles routing to the identical item form (differing only by
 * `?category=`) and a permanently-disabled 4th. This is now the shared
 * `BottomSheet` component with four genuinely different destinations: two
 * still navigate away (their own screens do the real work), two are
 * answered inline without ever leaving this sheet.
 */

type SheetMode = "menu" | "search" | "note";

function AddItemSheet() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const deviceId = useDeviceId();
  const day = searchParams.get("day");

  const [trip, setTrip] = useState<Trip | null>(null);
  const [mode, setMode] = useState<SheetMode>("menu");

  // "Search for a place" — inline, same Google-Places-backed lookup the item
  // form uses (app/plan/item/[id]/page.tsx), reused here via /api/places
  // rather than a new endpoint.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);

  // "Quick note" — inline text field, writes without leaving the sheet.
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  const closingRef = useRef(false);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const t = await getCurrentTrip(deviceId);
        if (!cancelled) setTrip(t);
      } catch (err) {
        console.error("[plan/add] trip load failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  useEffect(() => {
    if (mode !== "search") return;
    const term = query.trim();
    const destination = trip?.destination;
    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        if (term.length < 2 || !destination) {
          if (!cancelled) setResults([]);
          return;
        }
        setSearching(true);
        try {
          const params = new URLSearchParams({ destination, q: term });
          const res = await fetch(`/api/places?${params.toString()}`);
          const data = (await res.json()) as { places?: Place[] };
          if (!cancelled) setResults(data.places ?? []);
        } catch (err) {
          if (!cancelled) console.error("[plan/add] place search failed", err);
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, query, trip?.destination]);

  // Return to wherever the sheet was opened from (Home, Plan, a place page,
  // ...) rather than always dumping the user on /plan — Phase A fix, kept.
  function close() {
    if (closingRef.current) return;
    closingRef.current = true;
    router.back();
  }

  function chooseSearch() {
    setMode("search");
  }

  function chooseNearby() {
    router.push(day ? `/discover/gap?day=${day}` : "/discover/gap");
  }

  function chooseBooking() {
    const params = new URLSearchParams({ category: "reservation" });
    if (day) params.set("day", day);
    router.push(`/plan/item/new?${params.toString()}`);
  }

  function chooseNote() {
    setMode("note");
  }

  async function addPlace(place: Place) {
    if (!deviceId || !trip || addingId) return;
    setAddingId(place.id);
    try {
      await createItem(deviceId, {
        trip_id: trip.id,
        day_date: day || trip.start_date || null,
        time_label: null,
        starts_at: null,
        duration_minutes: null,
        category: "activity",
        title: place.name,
        location: [place.name, place.city ?? place.address ?? trip.destination].filter(Boolean).join(", "),
        weather_alert: false,
        color_tag: "green",
        place_id: place.id,
      });
      close();
    } catch (err) {
      console.error("[plan/add] add place failed", err);
      setAddingId(null);
    }
  }

  async function addNote() {
    if (!deviceId || !trip || !note.trim() || savingNote) return;
    setSavingNote(true);
    try {
      await createItem(deviceId, {
        trip_id: trip.id,
        day_date: day || trip.start_date || null,
        time_label: null,
        starts_at: null,
        duration_minutes: null,
        category: "note",
        title: note.trim(),
        location: null,
        weather_alert: false,
        color_tag: null,
        place_id: null,
      });
      close();
    } catch (err) {
      console.error("[plan/add] add note failed", err);
      setSavingNote(false);
    }
  }

  const ready = !!deviceId && !!trip;

  return (
    <BottomSheet
      open
      onClose={close}
      title={
        mode === "menu" ? (
          "Add to Itinerary"
        ) : (
          <span className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Back"
              onClick={() => setMode("menu")}
              className="-ml-1.5 flex h-8 w-8 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-high"
            >
              <Icon name="arrow_back" size={20} />
            </button>
            {mode === "search" ? "Search for a place" : "Quick note"}
          </span>
        )
      }
    >
      {mode === "menu" ? (
        <div className="grid grid-cols-2 gap-4 pb-2">
          {[
            { label: "Search for a place", icon: "location_on", onClick: chooseSearch },
            { label: "Browse what's nearby", icon: "explore", onClick: chooseNearby },
            { label: "Add a booking", icon: "confirmation_number", onClick: chooseBooking },
            { label: "Quick note", icon: "edit_document", onClick: chooseNote },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={option.onClick}
              className="group flex min-h-[120px] flex-col items-center justify-center gap-3 rounded-2xl border border-surface-variant bg-surface-container-low p-6 text-center transition-all hover:border-outline-variant hover:bg-surface-container"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-container-lowest text-secondary-container shadow-sm transition-transform group-hover:scale-110">
                <Icon name={option.icon} filled size={28} />
              </span>
              <span className="text-label-md text-on-surface">{option.label}</span>
            </button>
          ))}
        </div>
      ) : mode === "search" ? (
        <div className="flex flex-col gap-3 pb-2">
          <div className="relative flex items-center rounded-xl border border-outline-variant bg-surface-container-lowest px-3">
            <Icon name="search" size={18} className="text-on-surface-variant" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={!ready}
              placeholder={ready ? "e.g. Arashiyama Bamboo Grove" : "Loading…"}
              className="w-full bg-transparent px-2 py-3 text-body-md text-on-surface outline-none placeholder:text-on-surface-variant disabled:opacity-50"
            />
          </div>
          <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
            {searching ? (
              <p className="px-1 py-3 text-body-md text-on-surface-variant">Searching…</p>
            ) : query.trim().length >= 2 && results.length === 0 ? (
              <p className="px-1 py-3 text-body-md text-on-surface-variant">Nothing found for &ldquo;{query.trim()}&rdquo;.</p>
            ) : (
              results.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={addingId === p.id}
                  onClick={() => void addPlace(p)}
                  className="flex w-full flex-col items-start gap-0.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface-container disabled:opacity-60"
                >
                  <span className="text-body-md font-medium text-on-surface">
                    {addingId === p.id ? "Adding…" : p.name}
                  </span>
                  {p.address ? <span className="text-label-sm text-on-surface-variant">{p.address}</span> : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 pb-2">
          <Textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Pack the rain jacket, or call the ryokan to confirm check-in"
            rows={4}
          />
          <Button
            variant="navy"
            fullWidth
            disabled={!ready || !note.trim() || savingNote}
            onClick={() => void addNote()}
          >
            {savingNote ? "Saving…" : "Add note"}
          </Button>
        </div>
      )}
    </BottomSheet>
  );
}

export default function AddItemPage() {
  return (
    <Suspense fallback={null}>
      <AddItemSheet />
    </Suspense>
  );
}
