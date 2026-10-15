"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { buildAskFomoHref } from "@/lib/chat-seed";
import { getPlace, listPlacePhotos, listUpcomingEventsForPlace } from "@/lib/db";
import { useSaved } from "@/lib/useSaved";
import { buildDirectionsUrl } from "@/lib/maps/links";
import { CITY } from "@/lib/city";
import { localWeekday, todayHoursLabel, weekHoursLines } from "@/lib/places/hours";
import type { EventItem, Place, PlacePhoto } from "@/lib/types";
import { Button, FomoLoader, Icon, PhotoCarousel, ScrollRail, ShareButton, StatusPill } from "@/components/ui";
import type { CarouselPhoto } from "@/components/ui";
import { FeedListCard } from "@/components/happenings";
import { nextOccurrence, normalizeRecurrence } from "@/lib/happenings/occurrence";
import type { Happening } from "@/lib/happenings/types";
import type { HappeningCardData } from "@/lib/happenings/feed-types";
import type { PlaceOffersResponse } from "@/app/api/places/[id]/offers/route";
import { trackOutboundClicked } from "@/lib/analytics/track";
import type { PlaceDetailData } from "@/lib/places/detail";
import { LIST_PAGES } from "@/lib/seo/breadcrumbs";
import {
  ASIDE_CARD_CLASS,
  DETAIL_CONTENT_CLASS,
  DETAIL_CTA_BAR_CLASS,
  DETAIL_HERO_CLASS,
  DetailAside,
  DetailTopBar,
  MoreInLink,
  detailGridClass,
  type DetailProps,
} from "./shared";

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

/** Null on failure, so a failed refresh leaves the server-rendered offers in place. */
async function fetchPlaceOffers(id: string): Promise<Happening[] | null> {
  try {
    const res = await fetch(`/api/places/${id}/offers`);
    if (!res.ok) return null;
    const json = (await res.json()) as PlaceOffersResponse;
    return json.offers;
  } catch (err) {
    console.error("[place] offers fetch failed", err);
    return null;
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

/** "https://www.example.com/menu" → "example.com"; null for anything that isn't an http(s) URL. */
function websiteHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Today's hours from the structured `opening_hours` (tap for the full week); falls back to the free-text `hours`. Rendered in two places, so it owns its own open/closed state. */
function PlaceHours({ place }: { place: Place }) {
  const [expanded, setExpanded] = useState(false);
  const now = new Date();
  const today = todayHoursLabel(place.opening_hours, now, CITY.timezone);
  const week = weekHoursLines(place.opening_hours);
  const todayIndex = localWeekday(now, CITY.timezone);
  return (
    <div className="flex items-start gap-3">
      <Icon name="schedule" className="mt-0.5 text-primary" />
      <div className="min-w-0">
        <p className="text-label-sm text-on-surface-variant">Hours</p>
        {/* "Open today…" depends on the day: a cached page served just after midnight renders yesterday's. */}
        <p className="text-label-md text-on-surface" suppressHydrationWarning>
          {today ?? place.hours ?? "–"}
        </p>
        {week.length > 0 ? (
          <>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="mt-1 inline-flex items-center gap-0.5 text-label-sm font-medium text-secondary"
            >
              {expanded ? "Hide week" : "See full week"}
              <Icon name={expanded ? "expand_less" : "expand_more"} size={16} />
            </button>
            {expanded ? (
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-label-sm text-on-surface-variant">
                {week.map((line) => (
                  <div key={line.dayIndex} className="contents">
                    <dt className={line.dayIndex === todayIndex ? "font-bold text-on-surface" : ""}>{line.day}</dt>
                    <dd className={line.dayIndex === todayIndex ? "font-bold text-on-surface" : ""}>{line.text}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function PlaceDetail({ id, presentation = "page", initialData }: DetailProps & { initialData?: PlaceDetailData }) {
  const db = supabaseBrowserAuth();
  const pathname = usePathname();
  const { isSaved: checkSaved, toggle: toggleSaved } = useSaved();

  // `initialData` is what the server rendered for this route (app/(shell)/
  // place/[id]/page.tsx), so a shared link's first HTML already holds the
  // place. The overlay and in-app navigations don't pass it and load as
  // before. Either way the effects below still fetch a fresh copy.
  const hasInitial = initialData?.place != null;
  const [place, setPlace] = useState<Place | null>(initialData?.place ?? null);
  const [photos, setPhotos] = useState<PlacePhoto[]>(initialData?.photos ?? []);
  const [offers, setOffers] = useState<Happening[]>(initialData?.offers ?? []);
  const [events, setEvents] = useState<EventItem[]>(initialData?.events ?? []);
  const [placeLoading, setPlaceLoading] = useState(!hasInitial);
  // The page waits for offers too: they render above the description, so
  // arriving late would push the whole page down after first paint. Both
  // requests start together, so this costs little. Events sit below the
  // details, so they fill in whenever they arrive.
  const [offersLoading, setOffersLoading] = useState(!hasInitial);
  const loading = placeLoading || offersLoading;

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
        if (!cancelled) setPlaceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [db, id]);

  useEffect(() => {
    let cancelled = false;
    fetchPlaceOffers(id)
      .then((data) => {
        if (!cancelled && data) setOffers(data);
      })
      .catch((err) => console.error("Failed to load place offers", err))
      .finally(() => {
        if (!cancelled) setOffersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    listUpcomingEventsForPlace(db, id)
      .then((rows) => {
        if (!cancelled) setEvents(rows);
      })
      .catch((err) => console.error("Failed to load place events", err));
    return () => {
      cancelled = true;
    };
  }, [db, id]);

  if (loading) {
    return (
      <>
        {presentation === "modal" ? <DetailTopBar presentation="modal" /> : null}
        <div className={`flex items-center justify-center ${presentation === "modal" ? "min-h-[360px]" : "min-h-dvh"}`}>
          <FomoLoader />
        </div>
      </>
    );
  }

  if (!place) {
    return (
      <div className="flex flex-col gap-4">
        <DetailTopBar presentation={presentation} title="Place" />
        <div className="flex flex-col items-center gap-3 px-4 py-16 text-center text-on-surface-variant">
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
  const websiteLabel = place.website ? websiteHost(place.website) : null;
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
  const shareText = `${[placeName, primaryBadge].filter(Boolean).join(" · ")} · via Fomo`;

  // The location tile renders twice: in the left column (hidden at lg) and in
  // the desktop aside (hidden below lg). No effects or mount-time tracking in
  // it — only a click-time `trackOutboundClicked` — so the duplicate is free.
  const mapCard = (cls: string) => (
    <section className={cls}>
          <h2 className="mb-4 text-headline-sm text-primary">Location</h2>
          {directionsUrl ? (
            <a
              href={directionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackOutboundClicked("place", id, directionsUrl, "directions")}
              className="relative flex h-40 w-full overflow-hidden rounded-2xl bg-surface-container text-left shadow-level-1"
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <Icon name="map" size={64} className="text-outline-variant" />
              </div>
              <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2 rounded-lg bg-white/90 px-3 py-2 backdrop-blur-md">
                <div className="min-w-0">
                  <p className="truncate text-label-md text-primary">{place.station ?? place.name}</p>
                  <p className="text-label-sm text-on-surface-variant">Tap to open directions</p>
                </div>
                <Icon name="open_in_new" className="shrink-0 text-primary" />
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
              <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2 rounded-lg bg-white/90 px-3 py-2 backdrop-blur-md">
                <div className="min-w-0">
                  <p className="truncate text-label-md text-primary">{place.station ?? place.name}</p>
                  <p className="text-label-sm text-on-surface-variant">Location unavailable</p>
                </div>
              </div>
            </button>
          )}
        </section>
  );

  return (
    <div className="flex flex-col gap-4 pb-6">
      <DetailTopBar
        presentation={presentation}
        title={placeName}
        action={<ShareButton title={placeName} text={shareText} url={shareUrl} kind="place" />}
      />

      <div className={detailGridClass(presentation)}>
      {/* Hero */}
      <section className={DETAIL_HERO_CLASS}>
        <PhotoCarousel key={place.id} photos={heroPhotos} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-background/90 to-transparent" />
        {primaryBadge ? (
          <div className="absolute bottom-4 left-4 right-4 z-20 flex">
            <StatusPill
              label={primaryBadge}
              tone={isQuiet ? "success" : "info"}
              icon={isQuiet ? "check_circle" : "schedule"}
            />
          </div>
        ) : null}
      </section>

      <div className={DETAIL_CONTENT_CLASS}>
        {place.business_status === "CLOSED_PERMANENTLY" ? (
          <div role="status" className="flex items-start gap-2.5 rounded-2xl bg-error-container/40 p-3.5 text-on-surface">
            <Icon name="event_busy" size={20} className="mt-0.5 shrink-0 text-error" />
            <p className="text-body-md">
              <span className="font-bold">Google lists this as permanently closed.</span> Check before you go.
            </p>
          </div>
        ) : null}

        {/* Offers here — every live Deals & Offers happening linked to this
            place via place_id (Home restructure task 2). Reuses
            FeedListCard's happening row, same chrome as the Home Deals
            section's single (non-venue-grouped) cards. Sits straight under
            the photo, above the description: a venue deal card on /deals
            opens this page, and the offers it promised were a long scroll
            below the venue's details. */}
        {offers.length > 0 ? (
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Icon name="sell" size={20} className="text-accent" />
              <h2 className="text-headline-sm text-primary">Offers Here</h2>
              <span className="rounded-full bg-surface-container px-2.5 py-0.5 text-label-sm font-bold text-secondary">
                {offers.length}
              </span>
            </div>
            {/* One column at every size, like phones: this content column is
                narrow on desktop (beside the aside, and narrower still in the
                modal), and two cards abreast cut titles to "Traverse £1…". */}
            <div className="flex flex-col gap-3">
              {toOfferCards(offers).map((card) => (
                <FeedListCard key={card.happening.id} card={card} />
              ))}
            </div>
          </section>
        ) : null}

        {/* Upcoming events at this venue (events.place_id): what makes a
            venue's page worth opening, and the links search engines follow
            from the venue to each event. */}
        {events.length > 0 ? (
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Icon name="event" size={20} className="text-accent" />
              <h2 className="text-headline-sm text-primary">What&rsquo;s on here</h2>
              <span className="rounded-full bg-surface-container px-2.5 py-0.5 text-label-sm font-bold text-secondary">
                {events.length}
              </span>
            </div>
            <div className="flex flex-col gap-3">
              {events.map((event) => (
                <FeedListCard key={event.id} card={{ kind: "event", event }} />
              ))}
            </div>
          </section>
        ) : null}

        {/* Description & stats */}
        <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-level-1">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-secondary">
              <Icon name="star" filled size={18} />
              <span className="text-label-md text-on-surface-variant">
                {place.google_rating_count && place.rating != null
                  ? `${place.rating} (${place.google_rating_count.toLocaleString("en-GB")}) on Google`
                  : `${place.rating ?? "–"} (${reviews.length ? `${reviews.length}+ reviews` : "New"})`}
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
          {place.google_summary && place.google_summary_disclosure ? (
            <div className="mb-4">
              <p className="text-body-md text-on-surface-variant">{place.google_summary}</p>
              <p className="mt-1 text-label-sm text-on-surface-variant/70">{place.google_summary_disclosure}</p>
            </div>
          ) : null}
          {place.address || websiteLabel || place.phone || place.price_range ? (
            <ul className="mb-4 flex flex-col gap-2.5 border-t border-outline-variant/30 pt-4">
              {place.address ? (
                <li className="flex items-start gap-3">
                  <Icon name="location_on" className="mt-0.5 text-primary" />
                  {place.google_maps_uri ? (
                    <a
                      href={place.google_maps_uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => trackOutboundClicked("place", id, place.google_maps_uri ?? "", "maps")}
                      className="text-label-md text-on-surface underline decoration-outline-variant underline-offset-2"
                    >
                      {place.address}
                    </a>
                  ) : (
                    <span className="text-label-md text-on-surface">{place.address}</span>
                  )}
                </li>
              ) : null}
              {place.website && websiteLabel ? (
                <li className="flex items-start gap-3">
                  <Icon name="language" className="mt-0.5 text-primary" />
                  <a
                    href={place.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => trackOutboundClicked("place", id, place.website ?? "", "website")}
                    className="text-label-md text-secondary underline underline-offset-2"
                  >
                    {websiteLabel}
                  </a>
                </li>
              ) : null}
              {place.phone ? (
                <li className="flex items-start gap-3">
                  <Icon name="call" className="mt-0.5 text-primary" />
                  <a href={`tel:${place.phone.replace(/[^\d+]/g, "")}`} className="text-label-md text-secondary">
                    {place.phone}
                  </a>
                </li>
              ) : null}
              {place.price_range ? (
                <li className="flex items-start gap-3">
                  <Icon name="payments" className="mt-0.5 text-primary" />
                  <span className="text-label-md text-on-surface">{place.price_range}</span>
                </li>
              ) : null}
            </ul>
          ) : null}
          <div className="grid grid-cols-2 gap-4 border-t border-outline-variant/30 pt-4 lg:hidden">
            <PlaceHours place={place} />
            {directionsUrl ? (
              <a
                href={directionsUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackOutboundClicked("place", id, directionsUrl, "directions")}
                className="flex items-center gap-3 text-left"
              >
                <Icon name="near_me" className="text-primary" />
                <div>
                  <p className="text-label-sm text-on-surface-variant">Getting there</p>
                  <p className="text-label-md text-on-surface">Directions</p>
                </div>
              </a>
            ) : null}
          </div>
        </section>

        {/* Fomo's Tips */}
        {tips.length > 0 ? (
          <section>
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-container">
                <Icon name="smart_toy" size={20} className="text-on-primary-container" />
              </div>
              <h2 className="text-headline-sm text-primary">Fomo&rsquo;s Tips</h2>
            </div>
            <div className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4">
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
            <ScrollRail scrollerClassName="-mx-4 gap-4 px-4 pb-2 lg:mx-0 lg:px-0">
              {reviews.map((review, i) => (
                <div
                  key={i}
                  className="min-w-[260px] rounded-2xl bg-surface-container-lowest p-3.5 shadow-level-1"
                >
                  <div className="mb-2 flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-tertiary-fixed text-label-sm font-bold text-on-tertiary-fixed">
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
            </ScrollRail>
          </section>
        ) : null}

        {mapCard("lg:hidden")}

        <MoreInLink list={LIST_PAGES.explore} />
      </div>

      {/* Aside. Below lg this is `display: contents`: the actions bar is a
          plain sticky-bottom flex child of the page exactly as before, and the
          `hidden lg:block` cards stay hidden. At lg it is the sticky right
          column — hours/directions, the same single actions group (static
          there), and the location tile. */}
      <DetailAside presentation={presentation}>
      <section className={ASIDE_CARD_CLASS}>
          <div className="grid grid-cols-1 gap-4">
            <PlaceHours place={place} />
            {directionsUrl ? (
              <a
                href={directionsUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackOutboundClicked("place", id, directionsUrl, "directions")}
                className="flex items-center gap-3 text-left"
              >
                <Icon name="near_me" className="text-primary" />
                <div>
                  <p className="text-label-sm text-on-surface-variant">Getting there</p>
                  <p className="text-label-md text-on-surface">Directions</p>
                </div>
              </a>
            ) : null}
          </div>
      </section>

      <div className={DETAIL_CTA_BAR_CLASS}>
        <div className="flex gap-3">
          {directionsUrl ? (
            <a
              href={directionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackOutboundClicked("place", id, directionsUrl, "directions")}
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

      {mapCard("hidden lg:block")}
      </DetailAside>
      </div>
    </div>
  );
}
