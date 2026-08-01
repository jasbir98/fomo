"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useDeviceId } from "@/lib/device";
import {
  createItem,
  getCurrentTrip,
  getItem,
  getPlace,
  listPlacePhotos,
  updateItem,
} from "@/lib/db";
import type { Place, Trip } from "@/lib/types";
import { Button, Chip, Input, PageHeader, PhotoCarousel, Toggle } from "@/components/ui";
import type { CarouselPhoto } from "@/components/ui";

/**
 * Source: `edit_itinerary_item/code.html`. Full-screen form, handles both
 * NEW (`id === "new"`, category from `?category=`) and EDIT
 * (`getItem(deviceId, id)`). Save → create/update into the current trip,
 * then back to `/plan`. Cancel → back.
 */

const CATEGORY_OPTIONS: { value: string; label: string; icon: string }[] = [
  { value: "activity", label: "Activity", icon: "hiking" },
  { value: "dining", label: "Dining", icon: "restaurant" },
  { value: "booking", label: "Booking", icon: "confirmation_number" },
  { value: "reservation", label: "Reservation", icon: "event" },
  { value: "note", label: "Note", icon: "edit_note" },
];

// Sensible default color_tag per category for newly-created items — the
// timeline's left-accent bar color. Seeded demo items already carry one.
function defaultColorTag(category: string): string {
  switch (category) {
    case "activity":
      return "green";
    case "dining":
      return "orange";
    case "booking":
    case "reservation":
      return "blue";
    default:
      return "green";
  }
}

function weekdayFor(dayDate: string): string | null {
  if (!dayDate) return null;
  try {
    return new Date(`${dayDate}T00:00:00`).toLocaleDateString("en-US", { weekday: "long" });
  } catch {
    return null;
  }
}

function EditItemForm() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const deviceId = useDeviceId();
  const id = params.id;
  const isNew = id === "new";

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>(searchParams.get("category") ?? "activity");
  const [dayDate, setDayDate] = useState(searchParams.get("day") ?? "");
  const [timeLabel, setTimeLabel] = useState("");
  const [location, setLocation] = useState("");
  const [weatherAlert, setWeatherAlert] = useState(false);

  // Populated only when editing an existing item that has a `place_id`
  // (add_itinerary_place_id.sql) — items created from a real place (chat
  // rich-card, map pin, place detail page, social reel) can look it back up
  // and show its photo/description; manually-created items have none.
  const [place, setPlace] = useState<Place | null>(null);
  const [placePhotos, setPlacePhotos] = useState<CarouselPhoto[]>([]);

  // Google-Places-backed search, replacing the old separate Title + Location
  // text fields with one: the Title field itself searches Google Places, and
  // picking a suggestion fills both the title (place name) and the hidden
  // `location` (address/city) from the same selection — one place, one
  // field, instead of asking for the same thing twice. `placeId` is cleared
  // the moment the user edits the text, so saving after typing past a prior
  // selection doesn't silently keep stale coordinates attached to new text.
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Place[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searchingPlaces, setSearchingPlaces] = useState(false);
  // Set right before a suggestion-pick's setTitle() so the search effect
  // below (keyed on `title`) doesn't immediately re-query for the just
  // selected place's own name.
  const skipNextSearchRef = useRef(false);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const currentTrip = await getCurrentTrip(deviceId);
        if (cancelled) return;
        if (!currentTrip) {
          // No active trip to add items to — bounce to the create-trip flow.
          router.replace("/plan/new-trip");
          return;
        }
        setTrip(currentTrip);

        if (isNew) {
          if (!dayDate) setDayDate(currentTrip.start_date ?? "");
        } else {
          const item = await getItem(deviceId, id);
          if (cancelled) return;
          if (!item) {
            setNotFound(true);
            return;
          }
          setTitle(item.title ?? "");
          setCategory(item.category ?? "activity");
          setDayDate(item.day_date ?? currentTrip.start_date ?? "");
          setTimeLabel(item.time_label ?? "");
          setLocation(item.location ?? "");
          setWeatherAlert(item.weather_alert);
          setPlaceId(item.place_id);
          // The initial title is the item's saved name — skip the search
          // effect's very first fire so it doesn't immediately re-query
          // Google for the item's own name.
          skipNextSearchRef.current = true;

          if (item.place_id) {
            const [placeRow, photos] = await Promise.all([
              getPlace(item.place_id),
              listPlacePhotos(item.place_id),
            ]);
            if (cancelled) return;
            setPlace(placeRow);
            setPlacePhotos(
              photos.length > 0
                ? photos.map((p) => ({
                    url: p.url,
                    alt: placeRow?.name ?? "",
                    credit: p.credit || undefined,
                  }))
                : placeRow?.image_url
                  ? [{ url: placeRow.image_url, alt: placeRow.name ?? "" }]
                  : []
            );
          }
        }
      } catch (err) {
        console.error("[roameo] item load failed", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `dayDate` is read only as a one-time init guard; re-running on every
    // keystroke would clobber user edits, so it's intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, id, isNew]);

  // Debounced (300ms) Google-Places-backed search over the Title field,
  // same pattern as the Map page's places fetch (app/(shell)/map/page.tsx).
  // Reuses `/api/places?q=` (destination-scoped free-text search) rather than
  // a new endpoint — it already returns full `Place` rows with lat/lng.
  useEffect(() => {
    if (skipNextSearchRef.current) {
      skipNextSearchRef.current = false;
      return;
    }
    const query = title.trim();
    const destination = trip?.destination;
    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        if (query.length < 2 || !destination) {
          if (!cancelled) setSuggestions([]);
          return;
        }
        setSearchingPlaces(true);
        try {
          const params = new URLSearchParams({ destination, q: query });
          const res = await fetch(`/api/places?${params.toString()}`);
          const data = (await res.json()) as { places?: Place[] };
          if (!cancelled) setSuggestions(data.places ?? []);
        } catch (err) {
          if (!cancelled) console.error("[roameo] place search failed", err);
        } finally {
          if (!cancelled) setSearchingPlaces(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [title, trip?.destination]);

  function selectSuggestion(p: Place) {
    skipNextSearchRef.current = true;
    setTitle(p.name ?? "");
    setLocation([p.name, p.city ?? p.address ?? trip?.destination].filter(Boolean).join(", "));
    setPlaceId(p.id);
    setShowSuggestions(false);
    setSuggestions([]);
  }

  async function handleSave() {
    if (!deviceId || !trip || saving || !title.trim()) return;
    setSaving(true);
    try {
      const patch = {
        title: title.trim(),
        category,
        day_date: dayDate || null,
        time_label: timeLabel.trim() || null,
        location: location.trim() || null,
        weather_alert: weatherAlert,
        place_id: placeId,
      };
      if (isNew) {
        await createItem(deviceId, {
          trip_id: trip.id,
          ...patch,
          color_tag: defaultColorTag(category),
        });
      } else {
        await updateItem(deviceId, id, patch);
      }
      router.push("/plan");
    } catch (err) {
      console.error("[roameo] item save failed", err);
    } finally {
      setSaving(false);
    }
  }

  if (notFound) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-5 text-center">
        <p className="text-body-md text-on-surface-variant">This item couldn&apos;t be found.</p>
        <Button variant="outline" onClick={() => router.push("/plan")}>
          Back to Plan
        </Button>
      </div>
    );
  }

  const weekday = weekdayFor(dayDate);

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <PageHeader
        showBack
        title={isNew ? "New item" : "Edit item"}
        action={
          <button
            type="button"
            onClick={handleSave}
            disabled={!deviceId || loading || saving || !title.trim()}
            className="text-label-md font-bold text-secondary-container transition-opacity disabled:opacity-40"
          >
            Save
          </button>
        }
      />

      {place ? (
        <section className="flex flex-col gap-3 px-5 pt-4">
          <div className="relative h-48 w-full overflow-hidden rounded-xl bg-surface-container-high">
            <PhotoCarousel photos={placePhotos} />
          </div>
          {place.description ? (
            <p className="text-body-md text-on-surface-variant">{place.description}</p>
          ) : null}
        </section>
      ) : null}

      <main className="flex flex-1 flex-col gap-6 px-5 py-4">
        <div className="relative">
          <Input
            label="Title"
            leadingIcon="location_on"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setPlaceId(null);
              setLocation("");
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => {
              // Delay so a click on a suggestion (which fires before blur's
              // synchronous onClick handler otherwise loses the race) still
              // registers — the button's onMouseDown below beats this anyway,
              // but the timeout is a harmless second safety net.
              setTimeout(() => setShowSuggestions(false), 150);
            }}
            placeholder="Search a real place — e.g. Arashiyama Bamboo Grove"
            helperText={
              placeId
                ? location || undefined
                : "Type to search Google Places, or leave as free text for a note."
            }
          />
          {showSuggestions && (searchingPlaces || suggestions.length > 0) ? (
            <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-lg">
              {searchingPlaces ? (
                <div className="px-4 py-3 text-body-md text-on-surface-variant">Searching…</div>
              ) : (
                suggestions.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onMouseDown={(e) => {
                      // Fires before the input's onBlur, so the pick lands
                      // before blur can close the dropdown out from under it.
                      e.preventDefault();
                      selectSuggestion(p);
                    }}
                    className="flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left transition-colors hover:bg-surface-container"
                  >
                    <span className="text-body-md text-on-surface">{p.name}</span>
                    {p.address ? (
                      <span className="text-label-sm text-on-surface-variant">{p.address}</span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-label-md text-on-surface-variant font-medium">Category</span>
          <div className="no-scrollbar flex gap-2 overflow-x-auto">
            {CATEGORY_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                label={opt.label}
                leadingIcon={opt.icon}
                selected={category === opt.value}
                onClick={() => setCategory(opt.value)}
              />
            ))}
          </div>
        </div>

        <div className="flex gap-4">
          <Input
            label="Date"
            type="date"
            value={dayDate}
            onChange={(e) => setDayDate(e.target.value)}
            className="flex-1"
          />
          <Input
            label="Time"
            value={timeLabel}
            onChange={(e) => setTimeLabel(e.target.value)}
            placeholder="e.g. 3:00 PM"
            className="flex-1"
          />
        </div>

        <div className="mt-2 flex items-center justify-between rounded-xl border border-outline-variant bg-surface-container-lowest p-4 shadow-sm">
          <span className="text-label-md text-on-surface">Weather alerts for this item</span>
          <Toggle checked={weatherAlert} onChange={setWeatherAlert} />
        </div>
      </main>

      <div className="border-t border-outline-variant/60 bg-surface px-5 pb-safe pt-4">
        <Button
          variant="navy"
          fullWidth
          size="md"
          disabled={!deviceId || loading || saving || !title.trim()}
          onClick={handleSave}
          className="h-14 text-headline-sm"
        >
          {saving ? "Saving…" : weekday ? `Save to ${weekday}` : "Save"}
        </Button>
      </div>
    </div>
  );
}

export default function EditItemPage() {
  return (
    <Suspense fallback={null}>
      <EditItemForm />
    </Suspense>
  );
}
