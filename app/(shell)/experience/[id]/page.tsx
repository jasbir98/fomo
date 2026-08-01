"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeviceId } from "@/lib/device";
import { getExperience, getCurrentTrip, createItem, deleteItem, listItems } from "@/lib/db";
import type { Experience } from "@/lib/types";
import { formatExperiencePrice, formatExperienceRating } from "@/lib/experiences/format";
import { Button, Icon, PageHeader, PhotoCarousel, StatusPill } from "@/components/ui";
import type { CarouselPhoto } from "@/components/ui";

type AddState = "idle" | "adding" | "added" | "removing" | "error";

/** Human-readable badge for a provider slug ("viator" | "getyourguide"). */
function providerLabel(provider: string): string {
  const lower = provider.toLowerCase();
  if (lower.includes("viator")) return "Viator";
  if (lower.includes("getyourguide") || lower === "gyg") return "GetYourGuide";
  return provider;
}

export default function ExperienceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const deviceId = useDeviceId();
  const router = useRouter();

  const [experience, setExperience] = useState<Experience | null>(null);
  const [loading, setLoading] = useState(true);
  const [addState, setAddState] = useState<AddState>("idle");
  const [itemId, setItemId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getExperience(id)
      .then((data) => {
        if (cancelled) return;
        setExperience(data);
      })
      .catch((err) => console.error("Failed to load experience", err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Seed "already added" state from the current trip's itinerary so an
  // experience added on a previous visit shows "Remove" rather than a
  // dead-end "Added". Matched on experience_id — a real FK, unlike the place
  // page's title-string match.
  useEffect(() => {
    if (!deviceId || !experience) return;
    let cancelled = false;
    (async () => {
      try {
        const trip = await getCurrentTrip(deviceId);
        if (!trip || cancelled) return;
        const items = await listItems(deviceId, trip.id);
        const match = items.find((it) => it.experience_id === experience.id);
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
  }, [deviceId, experience]);

  async function handleAddToTrip() {
    if (!deviceId || !experience || addState === "adding" || addState === "added") return;
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
        experience_id: experience.id,
        title: experience.title,
        category: experience.category,
        location: experience.city ?? experience.title,
        day_date: trip.start_date,
      });
      setItemId(created.id);
      setAddState("added");
    } catch (err) {
      console.error("Failed to add experience to trip", err);
      setAddState("error");
    }
  }

  /** Un-add: same `deleteItem` used everywhere else "Add to itinerary"
   * exists (chat, map, place detail) — no duplicate removal logic added. */
  async function handleRemoveFromTrip() {
    if (!deviceId || !itemId || addState === "removing") return;
    setAddState("removing");
    try {
      await deleteItem(deviceId, itemId);
      setItemId(null);
      setAddState("idle");
    } catch (err) {
      console.error("Failed to remove experience from trip", err);
      setAddState("error");
    }
  }

  function handleBookNow() {
    if (experience?.booking_url) {
      window.open(experience.booking_url, "_blank", "noopener");
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Icon name="auto_awesome" size={32} className="animate-pulse text-primary" />
      </div>
    );
  }

  if (!experience) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Experience" showBack />
        <div className="flex flex-col items-center gap-3 px-5 py-16 text-center text-on-surface-variant">
          <Icon name="location_off" size={32} />
          <p className="text-body-md">We couldn&rsquo;t find this experience.</p>
          <Link href="/experiences" className="text-label-md font-medium text-secondary">
            Back to Experiences
          </Link>
        </div>
      </div>
    );
  }

  // Experiences don't have a multi-photo table like Place — just the one
  // image_url, so heroPhotos is 0-or-1-length. PhotoCarousel renders the
  // existing placeholder icon itself when empty.
  const heroPhotos: CarouselPhoto[] = experience.image_url
    ? [{ url: experience.image_url, alt: experience.title ?? "" }]
    : [];
  const price = formatExperiencePrice(experience);

  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageHeader title={experience.title ?? "Experience"} showBack />

      {/* Hero */}
      <section className="relative h-64 w-full overflow-hidden">
        <PhotoCarousel key={experience.id} photos={heroPhotos} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-background/90 to-transparent" />
        <div className="absolute bottom-4 left-5 z-20">
          <StatusPill
            label={providerLabel(experience.provider)}
            tone="info"
            icon="confirmation_number"
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
                {experience.rating != null ? formatExperienceRating(experience.rating) : "—"}{" "}
                {experience.review_count ? `(${experience.review_count} reviews)` : "(New)"}
              </span>
            </div>
            {experience.category ? (
              <span className="rounded-full bg-surface-container-low px-3 py-1 text-label-sm capitalize text-on-surface-variant">
                {experience.category}
              </span>
            ) : null}
          </div>
          {experience.city ? (
            <p className="mb-1 text-label-md font-medium text-secondary">
              {[experience.city, experience.country].filter(Boolean).join(", ")}
            </p>
          ) : null}
          <p className="mb-4 text-body-md text-on-surface-variant">
            {experience.description ??
              `${experience.category ?? "Experience"} in ${experience.city ?? experience.destination ?? "this destination"}`}
          </p>
          <div className="grid grid-cols-2 gap-4 border-t border-outline-variant/30 pt-4">
            <div className="flex items-center gap-3">
              <Icon name="schedule" className="text-primary" />
              <div>
                <p className="text-label-sm text-on-surface-variant">Duration</p>
                <p className="text-label-md text-on-surface">{experience.duration_label ?? "—"}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Icon name="payments" className="text-primary" />
              <div>
                <p className="text-label-sm text-on-surface-variant">Price</p>
                <p className="text-label-md text-on-surface">{price ? `${price} per person` : "—"}</p>
              </div>
            </div>
          </div>
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
            leadingIcon="confirmation_number"
            onClick={handleBookNow}
            disabled={!experience.booking_url}
          >
            Book Now
          </Button>
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
