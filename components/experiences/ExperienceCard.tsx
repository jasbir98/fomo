"use client";

import Link from "next/link";
import { Icon, SmartImage } from "@/components/ui";
import type { Experience } from "@/lib/types";
import { formatExperiencePrice, formatExperienceRating } from "@/lib/experiences/format";

export type ExperienceCardProps = {
  experience: Experience;
};

/** Human-readable badge for a provider slug ("viator" | "getyourguide"). */
function providerLabel(provider: string): string {
  const lower = provider.toLowerCase();
  if (lower.includes("viator")) return "Viator";
  if (lower.includes("getyourguide") || lower === "gyg") return "GetYourGuide";
  return provider;
}

/**
 * Home-strip carousel card for a bookable Experience. Links straight to
 * /experience/[id] — that page already has the full detail view (photo,
 * description, duration/price stats) and its own "Book Now" action, so this
 * card doesn't duplicate that; it's just the teaser, modelled on EventCard.
 */
export function ExperienceCard({ experience }: ExperienceCardProps) {
  const price = formatExperiencePrice(experience);
  return (
    <Link
      href={`/experience/${experience.id}`}
      className="flex w-[220px] shrink-0 snap-start flex-col overflow-hidden rounded-lg border border-outline-variant/60 bg-surface-container-lowest text-left shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="relative h-[140px] w-full shrink-0 overflow-hidden bg-surface-container">
        {experience.image_url ? (
          <SmartImage
            src={experience.image_url}
            alt={experience.title ?? ""}
            width={220}
            height={140}
            sizes="220px"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Icon name="local_activity" className="text-outline" />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 p-3">
        {experience.rating ? (
          <span className="flex items-center gap-1 text-label-sm text-secondary">
            <Icon name="star" filled size={14} />
            {formatExperienceRating(experience.rating)}
            {experience.review_count ? ` (${experience.review_count})` : ""}
          </span>
        ) : null}
        <h3 className="text-body-md font-semibold text-on-surface line-clamp-2">{experience.title}</h3>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-label-sm text-on-surface-variant">
            {providerLabel(experience.provider)}
          </span>
          {price ? (
            <span className="shrink-0 text-label-sm font-semibold text-primary">{price}</span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

export default ExperienceCard;
