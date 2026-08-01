"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useDeviceId } from "@/lib/device";
import { getCurrentTrip } from "@/lib/db";
import type { Experience, Trip } from "@/lib/types";
import { formatExperiencePrice, formatExperienceRating } from "@/lib/experiences/format";
import { Chip, Icon, PageHeader } from "@/components/ui";

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
// route's own default so a "load more" scroll fetches the same page size as
// the initial load.
const PAGE_SIZE = 12;

/** Human-readable badge for a provider slug ("viator" | "getyourguide"). */
function providerLabel(provider: string): string {
  const lower = provider.toLowerCase();
  if (lower.includes("viator")) return "Viator";
  if (lower.includes("getyourguide") || lower === "gyg") return "GetYourGuide";
  return provider;
}

export default function ExperiencesBrowsePage() {
  const deviceId = useDeviceId();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [tripChecked, setTripChecked] = useState(false);
  const [search, setSearch] = useState("");
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [experiences, setExperiences] = useState<Experience[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [degraded, setDegraded] = useState<string | null>(null);

  const destination = trip?.destination ?? null;
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Mutable mirrors read by the IntersectionObserver callback below, so the
  // observer only needs to be attached once per destination rather than torn
  // down and recreated on every keystroke/page fetch — same "read latest
  // value via ref" rationale as lib/useProgressiveReveal.ts.
  const liveRef = useRef({ destination, search, activeSlug, hasMore, loadingMore, experiences });
  useEffect(() => {
    liveRef.current = { destination, search, activeSlug, hasMore, loadingMore, experiences };
  });
  // Bumped on every filter change so a "load more" response that resolves
  // after the user has already switched search/category/destination gets
  // discarded instead of appending stale rows to the new list.
  const requestIdRef = useRef(0);

  // Load the active trip. No auto-seed — a device with no trip gets an empty
  // state that routes into the create-trip flow (mirrors app/(shell)/map/page.tsx).
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const t = await getCurrentTrip(deviceId);
        if (!cancelled) setTrip(t);
      } catch (err) {
        console.error("[experiences] trip load failed", err);
      } finally {
        if (!cancelled) setTripChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  // Fetch page 1 whenever destination, search, or category changes — resets
  // the accumulated list and pagination state. Debounced 300ms, same pattern
  // as app/(shell)/map/page.tsx.
  useEffect(() => {
    if (!destination) return;
    let cancelled = false;
    const myRequestId = ++requestIdRef.current;
    const trimmedSearch = search.trim();
    const params = new URLSearchParams({ destination, limit: String(PAGE_SIZE) });
    if (trimmedSearch) params.set("q", trimmedSearch);
    if (activeSlug) params.set("category", activeSlug);
    const timer = setTimeout(() => {
      (async () => {
        setLoading(true);
        try {
          const res = await fetch(`/api/experiences?${params.toString()}`);
          const data = (await res.json()) as ExperiencesResponse;
          if (cancelled || requestIdRef.current !== myRequestId) return;
          const rows = data.experiences ?? [];
          setExperiences(rows);
          setDegraded(data.degraded ?? null);
          setHasMore(rows.length >= PAGE_SIZE);
        } catch (err) {
          if (!cancelled) console.error("[experiences] load failed", err);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [destination, activeSlug, search]);

  // Infinite scroll: load the next page when the trailing sentinel scrolls
  // into view. Reads the current filters/accumulated-count via liveRef so it
  // doesn't need tearing down and recreating on every page fetch or
  // keystroke — but it DOES need `loading` in its deps: the sentinel <div>
  // only mounts once the first page has rendered (it lives inside the
  // "not loading" branch below), so `sentinelRef.current` is still null the
  // first time this effect runs (right when `destination` is set, while
  // `loading` is still true) — without re-running once `loading` flips to
  // false, the observer would never get attached to the real node at all.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !destination) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        const { destination: dest, search: s, activeSlug: slug, hasMore: more, loadingMore: busy, experiences: current } =
          liveRef.current;
        if (!dest || !more || busy) return;

        const myRequestId = requestIdRef.current;
        setLoadingMore(true);
        const params = new URLSearchParams({
          destination: dest,
          limit: String(PAGE_SIZE),
          offset: String(current.length),
        });
        const trimmed = s.trim();
        if (trimmed) params.set("q", trimmed);
        if (slug) params.set("category", slug);

        fetch(`/api/experiences?${params.toString()}`)
          .then((res) => res.json())
          .then((data: ExperiencesResponse) => {
            if (requestIdRef.current !== myRequestId) return; // filters changed mid-fetch
            const rows = data.experiences ?? [];
            setExperiences((prev) => {
              const seen = new Set(prev.map((p) => p.id));
              const fresh = rows.filter((r) => !seen.has(r.id));
              return fresh.length > 0 ? [...prev, ...fresh] : prev;
            });
            setHasMore(rows.length >= PAGE_SIZE);
          })
          .catch((err) => console.error("[experiences] load more failed", err))
          .finally(() => {
            if (requestIdRef.current === myRequestId) setLoadingMore(false);
          });
      },
      { rootMargin: "0px 0px 600px 0px", threshold: 0 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [destination, loading]);

  // No active trip — invite the traveler to create one (experiences need a destination).
  if (tripChecked && !trip) {
    return (
      <div className="flex min-h-dvh flex-col">
        <PageHeader title="Experiences" showBack />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary-fixed text-primary">
            <Icon name="confirmation_number" size={40} filled />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-headline-md text-primary">No trip to explore yet</h2>
            <p className="text-body-lg text-on-surface-variant">
              Create a trip to find experiences worth booking.
            </p>
          </div>
          <Link
            href="/plan/new-trip"
            className="mt-2 inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-secondary-container px-6 text-label-md font-semibold text-on-secondary-container shadow-sm transition-opacity hover:opacity-90"
          >
            <Icon name="add" size={20} />
            Create a trip
          </Link>
        </div>
      </div>
    );
  }

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
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={exp.image_url}
                        alt={exp.title ?? ""}
                        loading="lazy"
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
