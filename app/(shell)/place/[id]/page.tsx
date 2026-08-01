"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useDeviceId } from "@/lib/device";
import { buildAskRoameoHref } from "@/lib/chat-seed";
import {
  getPlace,
  listPlacePhotos,
  getCurrentTrip,
  createItem,
  deleteItem,
  listItems,
} from "@/lib/db";
import { buildDirectionsUrl } from "@/lib/maps/links";
import type { Place, PlacePhoto } from "@/lib/types";
import { Button, Icon, PageHeader, PhotoCarousel, StatusPill } from "@/components/ui";
import type { CarouselPhoto } from "@/components/ui";

type ParsedTip = { label: string | null; text: string };
type ParsedReview = { author: string; rating: number; text: string };
type AddState = "idle" | "adding" | "added" | "removing" | "error";

/** Place.tips is jsonb: an array of plain strings ("Label: text") or {label,text} objects. */
function parseTips(raw: unknown): ParsedTip[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): ParsedTip | null => {
      if (typeof entry === "string") {
        const idx = entry.indexOf(": ");
        if (idx > 0 && idx < 40) {
          return { label: entry.slice(0, idx), text: entry.slice(idx + 2) };
        }
        return { label: null, text: entry };
      }
      if (entry && typeof entry === "object") {
        const obj = entry as Record<string, unknown>;
        const text = typeof obj.text === "string" ? obj.text : null;
        if (!text) return null;
        return { label: typeof obj.label === "string" ? obj.label : null, text };
      }
      return null;
    })
    .filter((t): t is ParsedTip => t !== null);
}

/** Place.reviews is jsonb: an array of {author, rating, text}. */
function parseReviews(raw: unknown): ParsedReview[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): ParsedReview | null => {
      if (!entry || typeof entry !== "object") return null;
      const obj = entry as Record<string, unknown>;
      const text = typeof obj.text === "string" ? obj.text : null;
      if (!text) return null;
      const author = typeof obj.author === "string" ? obj.author : "Traveler";
      const rating = typeof obj.rating === "number" ? obj.rating : 5;
      return { author, rating, text };
    })
    .filter((r): r is ParsedReview => r !== null);
}

export default function PlaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const deviceId = useDeviceId();
  const router = useRouter();
  const pathname = usePathname();

  const [place, setPlace] = useState<Place | null>(null);
  const [photos, setPhotos] = useState<PlacePhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [addState, setAddState] = useState<AddState>("idle");
  const [itemId, setItemId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPlace(id), listPlacePhotos(id)])
      .then(([placeData, photoRows]) => {
        if (cancelled) return;
        setPlace(placeData);
        setPhotos(photoRows);
      })
      .catch((err) => console.error("Failed to load place", err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Seed "already added" state from the current trip's itinerary so a place
  // added on a previous visit shows "Remove" rather than a dead-end "Added".
  useEffect(() => {
    if (!deviceId || !place) return;
    let cancelled = false;
    (async () => {
      try {
        const trip = await getCurrentTrip(deviceId);
        if (!trip || cancelled) return;
        const items = await listItems(deviceId, trip.id);
        const match = items.find(
          (it) => it.title?.trim().toLowerCase() === place.name?.trim().toLowerCase()
        );
        if (cancelled) return;
        if (match) {
          setAddState("added");
          setItemId(match.id);
        }
      } catch (err) {
        console.error("Failed to check itinerary status", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, place]);

  async function handleAddToTrip() {
    if (!deviceId || !place || addState === "adding" || addState === "added") return;
    setAddState("adding");
    try {
      const trip = await getCurrentTrip(deviceId);
      if (!trip) {
        // No active trip — send the traveler to create one first.
        setAddState("idle");
        router.push("/plan/new-trip");
        return;
      }
      const created = await createItem(deviceId, {
        trip_id: trip.id,
        place_id: place.id,
        title: place.name,
        category: place.category,
        location: place.station ?? place.name,
        day_date: trip.start_date,
      });
      setItemId(created.id);
      setAddState("added");
    } catch (err) {
      console.error("Failed to add place to trip", err);
      setAddState("error");
    }
  }

  /** Un-add: same `deleteItem` used everywhere else "Add to itinerary"
   * exists (chat, map, reel detail) — no duplicate removal logic added. */
  async function handleRemoveFromTrip() {
    if (!deviceId || !itemId || addState === "removing") return;
    setAddState("removing");
    try {
      await deleteItem(deviceId, itemId);
      setItemId(null);
      setAddState("idle");
    } catch (err) {
      console.error("Failed to remove place from trip", err);
      setAddState("error");
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Icon name="auto_awesome" size={32} className="animate-pulse text-primary" />
      </div>
    );
  }

  if (!place) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Place" showBack />
        <div className="flex flex-col items-center gap-3 px-5 py-16 text-center text-on-surface-variant">
          <Icon name="location_off" size={32} />
          <p className="text-body-md">We couldn&rsquo;t find this place.</p>
          <Link href="/map" className="text-label-md font-medium text-secondary">
            Back to Map
          </Link>
        </div>
      </div>
    );
  }

  const tips = parseTips(place.tips);
  const reviews = parseReviews(place.reviews);
  const isQuiet = place.badges.includes("Quiet now");
  const primaryBadge = place.badges[0] ?? "Open now";
  const directionsUrl = buildDirectionsUrl(place);
  // place_photos when the pipeline found more than one citable image;
  // otherwise fall back to the single Place.image_url; otherwise none
  // (PhotoCarousel renders the existing placeholder icon itself).
  const heroPhotos: CarouselPhoto[] =
    photos.length > 0
      ? photos.map((p) => ({ url: p.url, alt: place.name ?? "", credit: p.credit || undefined }))
      : place.image_url
        ? [{ url: place.image_url, alt: place.name ?? "" }]
        : [];

  function openDirections() {
    if (directionsUrl) window.open(directionsUrl, "_blank", "noopener");
  }

  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageHeader title={place.name ?? "Place"} showBack />

      {/* Hero */}
      <section className="relative h-64 w-full overflow-hidden">
        <PhotoCarousel key={place.id} photos={heroPhotos} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-background/90 to-transparent" />
        <div className="absolute bottom-4 left-5 z-20">
          <StatusPill
            label={primaryBadge}
            tone={isQuiet ? "success" : "info"}
            icon={isQuiet ? "check_circle" : "schedule"}
          />
        </div>
      </section>

      <div className="flex flex-col gap-6 px-5">
        {/* Description & stats */}
        <section className="rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-secondary">
              <Icon name="star" filled size={18} />
              <span className="text-label-md text-on-surface-variant">
                {place.rating ?? "—"} ({reviews.length ? `${reviews.length}+ reviews` : "New"})
              </span>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {place.badges.slice(0, 2).map((badge) => (
                <span
                  key={badge}
                  className="rounded-full bg-surface-container-low px-3 py-1 text-label-sm text-on-surface-variant"
                >
                  {badge}
                </span>
              ))}
            </div>
          </div>
          {place.city ? (
            <p className="mb-1 text-label-md font-medium text-secondary">
              {[place.city, place.prefecture].filter(Boolean).join(", ")}
            </p>
          ) : null}
          <p className="mb-4 text-body-md text-on-surface-variant">
            {place.description ??
              `${place.category ?? "Spot"} near ${place.station ?? "your route"} — a Roameo pick worth the detour.`}
          </p>
          <div className="grid grid-cols-2 gap-4 border-t border-outline-variant/30 pt-4">
            <div className="flex items-center gap-3">
              <Icon name="schedule" className="text-primary" />
              <div>
                <p className="text-label-sm text-on-surface-variant">Hours</p>
                <p className="text-label-md text-on-surface">{place.hours ?? "—"}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Icon name="train" className="text-primary" />
              <div>
                <p className="text-label-sm text-on-surface-variant">Station</p>
                <p className="text-label-md text-on-surface">{place.station ?? "—"}</p>
              </div>
            </div>
          </div>
        </section>

        {/* Roameo's Tips */}
        {tips.length > 0 ? (
          <section>
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-container">
                <Icon name="smart_toy" size={20} className="text-on-primary-container" />
              </div>
              <h2 className="text-headline-sm text-primary">Roameo&rsquo;s Tips</h2>
            </div>
            <div className="flex flex-col gap-3">
              {tips.map((tip, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-4 rounded-xl p-5 ${
                    i === 0
                      ? "border-l-4 border-secondary-container bg-primary text-on-primary"
                      : "border border-outline-variant/40 bg-surface-container-lowest"
                  }`}
                >
                  <Icon
                    name={i === 0 ? "camera" : "restaurant"}
                    className={`mt-0.5 ${i === 0 ? "text-secondary-container" : "text-secondary"}`}
                  />
                  <div>
                    {tip.label ? (
                      <p
                        className={`mb-1 text-label-md ${
                          i === 0 ? "opacity-80" : "text-on-surface-variant"
                        }`}
                      >
                        {tip.label}
                      </p>
                    ) : null}
                    <p className="text-body-md font-medium">{tip.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Reviews */}
        {reviews.length > 0 ? (
          <section>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-headline-sm text-primary">Visitor Reviews</h2>
              <span className="text-label-md font-medium text-secondary">
                {reviews.length} total
              </span>
            </div>
            <div className="-mx-5 flex gap-4 overflow-x-auto px-5 pb-2 [&::-webkit-scrollbar]:hidden">
              {reviews.map((review, i) => (
                <div
                  key={i}
                  className="min-w-[260px] rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-4 shadow-sm"
                >
                  <div className="mb-2 flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-tertiary-fixed text-[11px] font-bold text-on-tertiary-fixed">
                      {review.author.slice(0, 2).toUpperCase()}
                    </div>
                    <p className="text-label-md text-on-surface">{review.author}</p>
                  </div>
                  <div className="mb-2 flex text-secondary-container">
                    {Array.from({ length: 5 }).map((_, idx) => (
                      <Icon
                        key={idx}
                        name="star"
                        filled={idx < Math.round(review.rating)}
                        size={14}
                      />
                    ))}
                  </div>
                  <p className="text-body-md text-on-surface-variant line-clamp-3">
                    {review.text}
                  </p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Mini map */}
        <section>
          <h2 className="mb-4 text-headline-sm text-primary">Location</h2>
          <button
            type="button"
            onClick={openDirections}
            disabled={!directionsUrl}
            className="relative h-40 w-full overflow-hidden rounded-xl border border-outline-variant/40 bg-surface-container text-left disabled:pointer-events-none disabled:opacity-60"
          >
            <div className="absolute inset-0 flex items-center justify-center">
              <Icon name="map" size={64} className="text-outline-variant" />
            </div>
            <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between rounded-lg bg-white/90 px-3 py-2 backdrop-blur-md">
              <div>
                <p className="text-label-md text-primary">{place.station ?? place.name}</p>
                <p className="text-label-sm text-on-surface-variant">
                  {directionsUrl ? "Tap to open directions" : "Location unavailable"}
                </p>
              </div>
              <Icon name="open_in_new" className="text-primary" />
            </div>
          </button>
        </section>
      </div>

      {/* Sticky bottom actions */}
      <div className="sticky bottom-[64px] z-30 flex flex-col gap-2 border-t border-outline-variant/40 bg-surface-container-lowest/95 px-5 py-4 backdrop-blur-md shadow-[0_-4px_16px_rgba(3,22,50,0.08)]">
        {addState === "added" ? (
          <div className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-on-primary">
            <Icon name="check_circle" filled size={18} className="text-secondary-container" />
            <p className="flex-1 text-label-md">Added to your trip.</p>
            <Link href="/plan" className="text-label-md font-semibold text-secondary-container">
              View Plan
            </Link>
          </div>
        ) : null}
        {addState === "error" ? (
          <div className="rounded-xl bg-error-container px-4 py-2.5 text-label-md text-on-error-container">
            Couldn&rsquo;t add to trip. Try again.
          </div>
        ) : null}
        <div className="flex gap-3">
          <Button
            variant="orange"
            fullWidth
            leadingIcon="directions"
            onClick={openDirections}
            disabled={!directionsUrl}
          >
            Get Directions
          </Button>
          <Link
            href={buildAskRoameoHref({
              type: "place",
              id,
              name: place.name ?? "This place",
              coords: place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : null,
              returnTo: pathname,
            })}
            aria-label="Ask Roameo about this place"
            className="flex min-h-[48px] items-center justify-center rounded-xl border-[1.5px] border-primary px-4 text-primary transition-colors hover:bg-primary/5 active:bg-primary/10"
          >
            <Icon name="chat" size={20} />
          </Link>
          <Button
            variant={addState === "added" ? "danger" : "outline"}
            leadingIcon={addState === "added" ? "delete" : "add_circle"}
            onClick={addState === "added" ? handleRemoveFromTrip : handleAddToTrip}
            disabled={addState === "adding" || addState === "removing"}
          >
            {addState === "added"
              ? "Remove"
              : addState === "adding"
                ? "Adding…"
                : addState === "removing"
                  ? "Removing…"
                  : "Add"}
          </Button>
        </div>
      </div>
    </div>
  );
}
