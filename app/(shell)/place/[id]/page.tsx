"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { buildAskFomoHref } from "@/lib/chat-seed";
import { getPlace, listPlacePhotos } from "@/lib/db";
import { useSaved } from "@/lib/useSaved";
import { buildDirectionsUrl } from "@/lib/maps/links";
import type { Place, PlacePhoto } from "@/lib/types";
import { Button, FomoLoader, Icon, PageHeader, PhotoCarousel, ShareButton, StatusPill } from "@/components/ui";
import type { CarouselPhoto } from "@/components/ui";
import { FeedListCard } from "@/components/happenings";
import { nextOccurrence, normalizeRecurrence } from "@/lib/happenings/occurrence";
import type { Happening } from "@/lib/happenings/types";
import type { HappeningCardData } from "@/lib/happenings/feed-types";
import type { PlaceOffersResponse } from "@/app/api/places/[id]/offers/route";

const ONE_YEAR_MS = 366 * 86_400_000;

/** GET /api/places/[id]/offers returns raw `Happening[]`, not the feed's `HappeningCardData` — the place page needs a display occurrence per row (a date-bucketed feed card already has one; a direct-link detail read doesn't), so it's computed here the same way the happening detail page computes its own upcoming list: `nextOccurrence` over a year-long window, or the single "always" pin for a standing offer. A happening with no occurrence in that window (an expired `once` row lib/db/happenings.ts's `status: "live"` filter hasn't caught up to yet) is dropped rather than shown dateless. */
function toOfferCards(offers: Happening[]): HappeningCardData[] {
  const now = new Date();
  const isAlways = (h: Happening) => normalizeRecurrence(h.recurrence).type === "always";
  return offers.flatMap((h) => {
    const occurrence = isAlways(h)
      ? nextOccurrence(h, now, now)
      : nextOccurrence(h, now, new Date(now.getTime() + ONE_YEAR_MS));
    return occurrence ? [{ kind: "happening" as const, happening: h, occurrence }] : [];
  });
}

async function fetchPlaceOffers(id: string): Promise<Happening[]> {
  try {
    const res = await fetch(`/api/places/${id}/offers`);
    if (!res.ok) return [];
    const json = (await res.json()) as PlaceOffersResponse;
    return json.offers;
  } catch (err) {
    console.error("[place] offers fetch failed", err);
    return [];
  }
}

type ParsedTip = { label: string | null; text: string };
type ParsedReview = { author: string; rating: number; text: string };

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
      const author = typeof obj.author === "string" ? obj.author : "Visitor";
      const rating = typeof obj.rating === "number" ? obj.rating : 5;
      return { author, rating, text };
    })
    .filter((r): r is ParsedReview => r !== null);
}

export default function PlaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const db = supabaseBrowserAuth();
  const pathname = usePathname();
  const { isSaved: checkSaved, toggle: toggleSaved } = useSaved();

  const [place, setPlace] = useState<Place | null>(null);
  const [photos, setPhotos] = useState<PlacePhoto[]>([]);
  const [offers, setOffers] = useState<Happening[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPlace(db, id), listPlacePhotos(db, id)])
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
  }, [db, id]);

  useEffect(() => {
    let cancelled = false;
    fetchPlaceOffers(id)
      .then((data) => {
        if (!cancelled) setOffers(data);
      })
      .catch((err) => console.error("Failed to load place offers", err));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <FomoLoader />
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
          <Link href="/explore" className="text-label-md font-medium text-secondary">
            Back to Explore
          </Link>
        </div>
      </div>
    );
  }

  const tips = parseTips(place.tips);
  const reviews = parseReviews(place.reviews);
  const isQuiet = place.badges.includes("Quiet now");
  // No badge, no pill — never claim "Open now" without data behind it.
  const primaryBadge = place.badges[0] ?? null;
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
  const placeName = place.name ?? "Place";
  // App isn't deployed yet — window.location.origin is the correct base for
  // a shareable link until there's a real production host.
  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}${pathname}` : "";
  const shareText = `${[placeName, primaryBadge].filter(Boolean).join(" · ")} — found on Fomo`;

  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageHeader
        title={placeName}
        showBack
        action={<ShareButton title={placeName} text={shareText} url={shareUrl} />}
      />

      {/* Hero */}
      <section className="relative h-64 w-full overflow-hidden">
        <PhotoCarousel key={place.id} photos={heroPhotos} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-background/90 to-transparent" />
        {primaryBadge ? (
          <div className="absolute bottom-4 left-5 z-20">
            <StatusPill
              label={primaryBadge}
              tone={isQuiet ? "success" : "info"}
              icon={isQuiet ? "check_circle" : "schedule"}
            />
          </div>
        ) : null}
      </section>

      <div className="flex flex-col gap-6 px-5">
        {/* Description & stats */}
        <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-level-1">
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
              {place.city}
            </p>
          ) : null}
          <p className="mb-4 text-body-md text-on-surface-variant">
            {place.description ?? `${place.category ?? "A spot"} in ${place.city ?? "Edinburgh"}.`}
          </p>
          <div className="grid grid-cols-2 gap-4 border-t border-outline-variant/30 pt-4">
            <div className="flex items-center gap-3">
              <Icon name="schedule" className="text-primary" />
              <div>
                <p className="text-label-sm text-on-surface-variant">Hours</p>
                <p className="text-label-md text-on-surface">{place.hours ?? "—"}</p>
              </div>
            </div>
            {directionsUrl ? (
              <a href={directionsUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 text-left">
                <Icon name="near_me" className="text-primary" />
                <div>
                  <p className="text-label-sm text-on-surface-variant">Getting there</p>
                  <p className="text-label-md text-on-surface">Directions</p>
                </div>
              </a>
            ) : null}
          </div>
        </section>

        {/* Offers here — every live Deals & Offers happening linked to this
            place via place_id (Home restructure task 2). Reuses
            FeedListCard's happening row, same chrome as the Home Deals
            section's single (non-venue-grouped) cards. */}
        {offers.length > 0 ? (
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Icon name="sell" size={20} className="text-accent" />
              <h2 className="text-headline-sm text-primary">Offers Here</h2>
              <span className="rounded-full bg-surface-container px-2.5 py-0.5 text-label-sm font-bold text-secondary">
                {offers.length}
              </span>
            </div>
            <div className="flex flex-col gap-3">
              {toOfferCards(offers).map((card) => (
                <FeedListCard key={card.happening.id} card={card} />
              ))}
            </div>
          </section>
        ) : null}

        {/* Fomo's Tips */}
        {tips.length > 0 ? (
          <section>
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-container">
                <Icon name="smart_toy" size={20} className="text-on-primary-container" />
              </div>
              <h2 className="text-headline-sm text-primary">Fomo&rsquo;s Tips</h2>
            </div>
            <div className="flex flex-col gap-3">
              {tips.map((tip, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-4 rounded-2xl p-5 shadow-level-1 ${
                    i === 0
                      ? "border-l-4 border-secondary-fixed-dim bg-primary text-on-primary"
                      : "bg-surface-container-lowest"
                  }`}
                >
                  <Icon
                    name={i === 0 ? "camera" : "restaurant"}
                    className={`mt-0.5 ${i === 0 ? "text-secondary-fixed-dim" : "text-secondary"}`}
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
                  className="min-w-[260px] rounded-2xl bg-surface-container-lowest p-4 shadow-level-1"
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
          {directionsUrl ? (
            <a
              href={directionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="relative flex h-40 w-full overflow-hidden rounded-2xl bg-surface-container text-left shadow-level-1"
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <Icon name="map" size={64} className="text-outline-variant" />
              </div>
              <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between rounded-lg bg-white/90 px-3 py-2 backdrop-blur-md">
                <div>
                  <p className="text-label-md text-primary">{place.station ?? place.name}</p>
                  <p className="text-label-sm text-on-surface-variant">Tap to open directions</p>
                </div>
                <Icon name="open_in_new" className="text-primary" />
              </div>
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="relative h-40 w-full overflow-hidden rounded-2xl bg-surface-container text-left shadow-level-1 disabled:pointer-events-none disabled:opacity-60"
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <Icon name="map" size={64} className="text-outline-variant" />
              </div>
              <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between rounded-lg bg-white/90 px-3 py-2 backdrop-blur-md">
                <div>
                  <p className="text-label-md text-primary">{place.station ?? place.name}</p>
                  <p className="text-label-sm text-on-surface-variant">Location unavailable</p>
                </div>
              </div>
            </button>
          )}
        </section>
      </div>

      {/* Sticky bottom actions */}
      <div className="sticky bottom-[calc(64px+env(safe-area-inset-bottom))] z-30 flex flex-col gap-2 border-t border-outline-variant/40 bg-surface-container-lowest/95 px-5 py-4 backdrop-blur-md shadow-[0_-4px_16px_rgba(3,22,50,0.08)]">
        <div className="flex gap-3">
          {directionsUrl ? (
            <a
              href={directionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-secondary-container px-6 text-label-md font-medium text-on-secondary-container shadow-sm transition-all hover:opacity-90 active:opacity-80"
            >
              <Icon name="directions" size={18} />
              Get Directions
            </a>
          ) : (
            <Button
              variant="orange"
              fullWidth
              leadingIcon="directions"
              disabled
            >
              Get Directions
            </Button>
          )}
          <Link
            href={buildAskFomoHref({
              type: "place",
              id,
              name: place.name ?? "This place",
              coords: place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : null,
              returnTo: pathname,
            })}
            aria-label="Ask Fomo about this place"
            className="flex min-h-[48px] items-center justify-center rounded-xl border-[1.5px] border-primary px-4 text-primary transition-colors hover:bg-primary/5 active:bg-primary/10"
          >
            <Icon name="chat" size={20} />
          </Link>
          <Button
            variant={checkSaved("place", id) ? "danger" : "outline"}
            leadingIcon={checkSaved("place", id) ? "bookmark" : "bookmark_border"}
            onClick={() => void toggleSaved("place", id)}
          >
            {checkSaved("place", id) ? "Saved" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
