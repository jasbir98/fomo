"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { getExperience } from "@/lib/db";
import { isSaved, saveItem, unsaveItem } from "@/lib/db/saved";
import type { Experience } from "@/lib/types";
import { formatExperiencePrice, formatExperienceRating } from "@/lib/experiences/format";
import { Button, Icon, PageHeader, PhotoCarousel, ShareButton, StatusPill } from "@/components/ui";
import type { CarouselPhoto } from "@/components/ui";

/** Human-readable badge for a provider slug ("viator" | "getyourguide"). */
function providerLabel(provider: string): string {
  const lower = provider.toLowerCase();
  if (lower.includes("viator")) return "Viator";
  if (lower.includes("getyourguide") || lower === "gyg") return "GetYourGuide";
  return provider;
}

export default function ExperienceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const db = supabaseBrowserAuth();
  const pathname = usePathname();

  const [experience, setExperience] = useState<Experience | null>(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [savePending, setSavePending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getExperience(db, id)
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
  }, [db, id]);

  useEffect(() => {
    let cancelled = false;
    isSaved(db, "experience", id)
      .then((value) => {
        if (!cancelled) setSaved(value);
      })
      .catch((err) => console.error("Failed to check saved status", err));
    return () => {
      cancelled = true;
    };
  }, [db, id]);

  async function handleToggleSave() {
    if (savePending) return;
    setSavePending(true);
    try {
      if (saved) {
        await unsaveItem(db, "experience", id);
        setSaved(false);
      } else {
        await saveItem(db, { subject_type: "experience", subject_id: id, note: null });
        setSaved(true);
      }
    } catch (err) {
      console.error("Failed to update saved status", err);
    } finally {
      setSavePending(false);
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
  const experienceTitle = experience.title ?? "Experience";
  // App isn't deployed yet — window.location.origin is the correct base for
  // a shareable link until there's a real production host.
  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}${pathname}` : "";
  const shareText = `${[experienceTitle, price || "Free"].filter(Boolean).join(" · ")} — found on Fomo`;

  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageHeader
        title={experienceTitle}
        showBack
        action={<ShareButton title={experienceTitle} text={shareText} url={shareUrl} />}
      />

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
      <div className="sticky bottom-[calc(64px+env(safe-area-inset-bottom))] z-30 flex flex-col gap-2 border-t border-outline-variant/40 bg-surface-container-lowest/95 px-5 py-4 backdrop-blur-md shadow-[0_-4px_16px_rgba(3,22,50,0.08)]">
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
            variant={saved ? "danger" : "outline"}
            leadingIcon={saved ? "bookmark" : "bookmark_border"}
            onClick={handleToggleSave}
            disabled={savePending}
          >
            {saved ? "Saved" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
