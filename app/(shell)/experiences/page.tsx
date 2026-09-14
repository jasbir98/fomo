"use client";

import { useState } from "react";
import Link from "next/link";
import { useSelectedCity } from "@/lib/useSelectedCity";
import type { Experience } from "@/lib/types";
import { formatExperiencePrice, formatExperienceRating } from "@/lib/experiences/format";
import { useInfiniteList } from "@/lib/useInfiniteList";
import { Chip, Icon, PageHeader, SmartImage } from "@/components/ui";

/** Category chip → the slug the /api/experiences route understands. */
const CATEGORY_FILTERS: { label: string; icon: string; slug: string }[] = [
  { label: "Tours", icon: "tour", slug: "tours" },
  { label: "Day Trips", icon: "directions_bus", slug: "day-trips" },
  { label: "Tickets & Passes", icon: "confirmation_number", slug: "tickets" },
  { label: "Food & Drink", icon: "restaurant", slug: "food-drink" },
  { label: "Outdoor", icon: "hiking", slug: "outdoor" },
];

interface ExperiencesResponse {
  center: { lat: number; lng: number } | null;
  experiences: Experience[];
  degraded?: string;
}

// One provider search page's worth of results — matches the /api/experiences
// route's own default (lib/experiences/getForDestination.ts's DEFAULT_LIMIT)
// so a "load more" scroll fetches the same page size as the initial load.
const PAGE_SIZE = 24;

/** Human-readable badge for a provider slug ("viator" | "getyourguide"). */
function providerLabel(provider: string): string {
  const lower = provider.toLowerCase();
  if (lower.includes("viator")) return "Viator";
  if (lower.includes("getyourguide") || lower === "gyg") return "GetYourGuide";
  return provider;
}

export default function ExperiencesBrowsePage() {
  const [search, setSearch] = useState("");
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [degraded, setDegraded] = useState<string | null>(null);

  const { city } = useSelectedCity();
  const destination = city.name;

  // Paginated fetch — shared infinite-scroll machinery (liveRef mirror,
  // fetch-generation counter, hasMore-from-page-size) lives in
  // lib/useInfiniteList.ts now; this page only supplies the request shape.
  const {
    items: experiences,
    loading,
    loadingMore,
    hasMore,
    sentinelRef,
  } = useInfiniteList<Experience>(
    {
      enabled: !!destination,
      pageSize: PAGE_SIZE,
      debounceMs: 300,
      getId: (e) => e.id,
      onError: (err, phase) =>
        console.error(`[experiences] ${phase === "initial" ? "load" : "load more"} failed`, err),
      fetchPage: async ({ limit, offset }) => {
        if (!destination) return [];
        const trimmedSearch = search.trim();
        const params = new URLSearchParams({ destination, limit: String(limit), offset: String(offset) });
        if (trimmedSearch) params.set("q", trimmedSearch);
        if (activeSlug) params.set("category", activeSlug);
        const res = await fetch(`/api/experiences?${params.toString()}`);
        const data = (await res.json()) as ExperiencesResponse;
        setDegraded(data.degraded ?? null);
        return data.experiences ?? [];
      },
    },
    [destination, activeSlug, search]
  );

  return (
    <div className="flex flex-col gap-4 pb-6">
      <PageHeader title="Experiences" showBack />

      <div className="flex flex-col gap-4 px-5">
        {/* Search bar */}
        <div className="flex h-12 items-center gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest px-4 shadow-sm">
          <Icon name="search" size={20} className="text-primary" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search experiences…"
            className="flex-1 bg-transparent text-body-md text-on-surface placeholder:text-on-surface-variant outline-none"
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch("")}
              className="text-on-surface-variant transition-colors hover:text-primary"
            >
              <Icon name="close" size={20} />
            </button>
          ) : null}
        </div>

        {/* Category filter chips — drive the /api/experiences query */}
        <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [&::-webkit-scrollbar]:hidden">
          {CATEGORY_FILTERS.map((c) => (
            <Chip
              key={c.slug}
              label={c.label}
              leadingIcon={c.icon}
              selected={activeSlug === c.slug}
              onClick={() => setActiveSlug((prev) => (prev === c.slug ? null : c.slug))}
            />
          ))}
        </div>

        {degraded ? (
          <p className="text-label-sm text-on-surface-variant">
            {degraded === "no-results"
              ? "No live experiences available right now."
              : degraded === "no-live-results"
                ? "Showing previously cached experiences."
                : "Live experience search is unavailable — showing what we have."}
          </p>
        ) : null}
      </div>

      {/* Results */}
      <section className="flex flex-col gap-3 px-5">
        {loading ? (
          <div className="flex justify-center py-6">
            <Icon name="hourglass_top" size={28} className="animate-pulse text-primary" />
          </div>
        ) : experiences.length === 0 ? (
          <p className="text-body-md text-on-surface-variant">
            No experiences found for {destination ?? "this destination"} yet.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {experiences.map((exp) => {
              const price = formatExperiencePrice(exp);
              return (
                <Link
                  key={exp.id}
                  href={`/experience/${exp.id}`}
                  className="flex gap-3 overflow-hidden rounded-xl border border-outline-variant/60 bg-surface-container-lowest p-3 shadow-sm transition-shadow hover:shadow-md"
                >
                  <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-surface-container">
                    {exp.image_url ? (
                      <SmartImage
                        src={exp.image_url}
                        alt={exp.title ?? ""}
                        width={96}
                        height={96}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <Icon name="local_activity" className="text-outline" />
                      </div>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <h3 className="text-headline-sm text-on-surface line-clamp-2">{exp.title}</h3>
                    <div className="flex items-center gap-2 text-label-sm text-on-surface-variant">
                      {exp.rating ? (
                        <span className="flex items-center gap-0.5 text-secondary">
                          <Icon name="star" filled size={14} /> {formatExperienceRating(exp.rating)}
                          {exp.review_count ? ` (${exp.review_count})` : ""}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-auto flex items-center justify-between gap-2">
                      <span className="rounded-full bg-surface-container-low px-2.5 py-1 text-label-sm text-on-surface-variant">
                        {providerLabel(exp.provider)}
                      </span>
                      {price ? (
                        <span className="text-label-md font-semibold text-primary">{price}</span>
                      ) : null}
                    </div>
                  </div>
                </Link>
              );
            })}
            {hasMore ? (
              <div ref={sentinelRef} className="flex justify-center py-4">
                {loadingMore ? (
                  <Icon name="hourglass_top" size={22} className="animate-pulse text-primary" />
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
