/**
 * Search-engine facing summary of a deal/happening or an event: the page's
 * meta description, whether it is still worth indexing, and (for something
 * with a real date and place) schema.org Event structured data.
 *
 * Pure, so it can be unit-tested; the detail pages' generateMetadata and
 * JSON-LD both read from here so the two never disagree.
 *
 * Dates are written out ("Sat 11 Oct 2026"), never "Today"/"Tonight": these
 * pages are cached for minutes to hours, and a snippet saying "Today" a day
 * later would be wrong.
 */
import { CITY } from "@/lib/city";
import { eventDayDate, eventHasEnded, formatEventPrice, formatEventTime, isDateOnlyStart } from "@/lib/events/format";
import {
  occurrenceDateLabel,
  occurrenceRangeLabel,
  recurrencePatternLabel,
  savingBadgeLabel,
} from "@/lib/happenings/format";
import { happeningHasEnded, nextOccurrence, normalizeRecurrence } from "@/lib/happenings/occurrence";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem, Place } from "@/lib/types";
import { describe } from "./metadata";
import { absoluteUrl } from "./site";

export interface DetailSeo {
  description: string | undefined;
  /** True when the page is for something that has ended or been withdrawn. */
  noindex: boolean;
  jsonLd: Record<string, unknown> | null;
}

const YEAR_MS = 366 * 86_400_000;

function geoPlace(venueName: string | null, address: string | null, lat: number | null, lng: number | null) {
  if (!venueName && !address) return undefined;
  return {
    "@type": "Place",
    name: venueName ?? address,
    address: {
      "@type": "PostalAddress",
      streetAddress: address ?? undefined,
      addressLocality: CITY.name,
      addressCountry: CITY.countryCode,
    },
    ...(lat != null && lng != null ? { geo: { "@type": "GeoCoordinates", latitude: lat, longitude: lng } } : {}),
  };
}

/**
 * No source records the promoter, so the venue stands in as the host: it is
 * who runs or puts on most of what we list, and a named organizer is what
 * Google asks for. Its url is the venue's own website, else its page here
 * when the row is linked to one. Nothing comes back without a venue name.
 */
function venueOrganizer(venueName: string | null, placeId: string | null, website?: string | null) {
  if (!venueName) return undefined;
  const url = website || (placeId ? absoluteUrl(`/place/${placeId}`) : undefined);
  return { "@type": "Organization", name: venueName, ...(url ? { url } : {}) };
}

export function happeningSeo(h: Happening, now: Date = new Date(), venueWebsite?: string | null): DetailSeo {
  const rec = normalizeRecurrence(h.recurrence);
  const next = nextOccurrence(h, now, new Date(now.getTime() + YEAR_MS));
  // The row's own saving label ("£5 student tickets") says more than the short badge ("£5").
  const price = h.is_free ? "Free" : (h.saving_label ?? savingBadgeLabel(h));
  // A one-off reads as its date; a repeating one as its pattern ("Every Saturday"), since "next Saturday's date" is stale by then.
  const when =
    rec.type === "always"
      ? "Every day"
      : rec.type === "once"
        ? next && occurrenceRangeLabel(next)
        : (recurrencePatternLabel(rec) ?? (next && occurrenceRangeLabel(next)));
  const description = describe([price, when, h.venue_name, h.summary]);
  const noindex = h.status !== "live" || happeningHasEnded(h, now);

  // Only something with a real start time and a place is an Event to Google.
  // A standing deal ("always", or a rule with no fixed time) is not.
  let jsonLd: Record<string, unknown> | null = null;
  const location = geoPlace(h.venue_name, h.address, h.lat, h.lng);
  if (!noindex && next?.exact && next.startsAt && rec.type === "once" && location) {
    jsonLd = {
      "@context": "https://schema.org",
      "@type": "Event",
      name: h.title,
      description: h.summary ?? description,
      startDate: next.startsAt,
      endDate: next.endsAt ?? undefined,
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      location,
      organizer: venueOrganizer(h.venue_name, h.place_id, venueWebsite),
      image: h.image_url ? [h.image_url] : undefined,
      url: absoluteUrl(`/happening/${h.id}`),
      offers: happeningOffer(h),
    };
  } else if (!noindex) {
    // Not an Event (a standing deal, or a dated one with no fixed time or
    // place): the deal itself is the thing on the page, so it is the Offer.
    const offer = happeningOffer(h);
    jsonLd = {
      "@context": "https://schema.org",
      ...offer,
      name: h.title,
      description: h.summary ?? description,
      image: h.image_url ? [h.image_url] : undefined,
      offeredBy: venueOrganizer(h.venue_name, h.place_id, venueWebsite),
      areaServed: { "@type": "City", name: CITY.name },
      validThrough: h.ends_at ?? undefined,
      // The landing page is ours; the booking link stays on the Offer only for an Event.
      url: absoluteUrl(`/happening/${h.id}`),
    };
  }
  return { description, noindex, jsonLd };
}

/**
 * The price a deal's label names, when it names one ("£4 tickets", "£21.95
 * student ticket"). Not `saving_amount`: on some rows that is the saving, not
 * the price (lib/happenings/format.ts's savingBadgeLabel has the cases), and a
 * "£5 off" price would be wrong. Undefined when the label is a saving.
 */
export function labelledPrice(label: string | null): number | undefined {
  if (!label || /\boff\b|%|\bfor\b|\bsave/i.test(label)) return undefined;
  const match = label.match(/£\s*(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : undefined;
}

/**
 * schema.org Offer for a happening, free or paid. A paid one carries its price
 * only when the label names it, and its label as the description either way,
 * so "2-for-1" or "20% off" still reads right.
 */
function happeningOffer(h: Happening): Record<string, unknown> {
  const price = h.is_free === true ? 0 : labelledPrice(h.saving_label);
  return {
    "@type": "Offer",
    ...(price != null ? { price, priceCurrency: h.currency ?? "GBP" } : {}),
    description: h.is_free === true ? undefined : (h.saving_label ?? undefined),
    url: h.booking_url ?? h.source_url,
    availability: "https://schema.org/InStock",
    validFrom: h.booking_opens_at ?? undefined,
  };
}

/** "Sat 11 Oct 2026, 19:30" ("Sat 11 Oct 2026" for a date-only start). */
function eventWhenLabel(e: Pick<EventItem, "starts_at">): string {
  const day = eventDayDate(e.starts_at);
  if (!day) return "";
  const time = isDateOnlyStart(e.starts_at) ? "" : formatEventTime(e.starts_at);
  return time ? `${occurrenceDateLabel(day)}, ${time}` : occurrenceDateLabel(day);
}

export function eventSeo(e: EventItem, now: Date = new Date()): DetailSeo {
  const description = describe([formatEventPrice(e), eventWhenLabel(e), e.venue_name, e.description]);
  const noindex = eventHasEnded(e, now);

  let jsonLd: Record<string, unknown> | null = null;
  const location = geoPlace(e.venue_name, e.address, e.lat, e.lng);
  if (!noindex && location && !Number.isNaN(Date.parse(e.starts_at))) {
    const priced = e.is_free === true || e.price_from != null;
    // Fall back to the linked venue's photo, the same one the card shows.
    const image = e.image_url || e.place?.image_url;
    jsonLd = {
      "@context": "https://schema.org",
      "@type": "Event",
      name: e.name,
      description: e.description ?? description,
      startDate: e.starts_at,
      endDate: e.ends_at ?? undefined,
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      location,
      organizer: venueOrganizer(e.place?.name ?? e.venue_name, e.place_id, e.place?.website),
      image: image ? [image] : undefined,
      url: absoluteUrl(`/event/${e.id}`),
      offers: priced
        ? {
            "@type": "Offer",
            // `price_from` is a floor, the cheapest tier a provider reported: say so rather than imply an exact price.
            price: e.is_free ? 0 : e.price_from,
            priceCurrency: e.currency ?? "GBP",
            url: e.ticket_url ?? undefined,
            availability: "https://schema.org/InStock",
          }
        : undefined,
    };
  }
  return { description, noindex, jsonLd };
}

/**
 * schema.org type for a place, from its free-text category (the pipeline
 * writes "pub", "historic building", "nature-reserve"…). Businesses get their
 * LocalBusiness subtype; everything else, most of the catalogue (parks,
 * viewpoints, castles, museums), is a TouristAttraction, with the more exact
 * type alongside where schema.org has one.
 */
const PLACE_TYPES: [RegExp, string | string[]][] = [
  [/\b(pub|bar)s?\b/, "BarOrPub"],
  [/\b(cafe|café|coffee)/, "CafeOrCoffeeShop"],
  [/restaurant|bistro|eatery/, "Restaurant"],
  [/cinema/, "MovieTheater"],
  [/theatre|theater|music venue|comedy|arts centre|^venue$/, "EventVenue"],
  [/museum/, ["Museum", "TouristAttraction"]],
  [/gallery/, ["ArtGallery", "TouristAttraction"]],
  [/\bpark\b|garden/, ["Park", "TouristAttraction"]],
  [/church|cathedral|abbey|chapel/, ["PlaceOfWorship", "TouristAttraction"]],
  [/beach/, ["Beach", "TouristAttraction"]],
];

export function placeSchemaType(category: string | null): string | string[] {
  const c = (category ?? "").toLowerCase().replace(/[-_]/g, " ").trim();
  for (const [pattern, type] of PLACE_TYPES) if (pattern.test(c)) return type;
  return "TouristAttraction";
}

const SCHEMA_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Park in Leith, Edinburgh" / "Museum in Edinburgh". */
function placeKindLine(place: Pick<Place, "category" | "city" | "destination">): string {
  const kind = place.category ? place.category.charAt(0).toUpperCase() + place.category.slice(1).replace(/[-_]/g, " ") : "Place";
  const area = place.city || place.destination;
  return `${kind} in ${area && area !== CITY.name ? `${area}, ${CITY.name}` : CITY.name}`;
}

export interface PlaceSeoInput {
  place: Place;
  /** Live offers linked to the place. */
  offers: Happening[];
  /** Upcoming events at the place. */
  events: EventItem[];
}

export function placeSeo({ place, offers, events }: PlaceSeoInput): DetailSeo {
  const description = describe([
    placeKindLine(place),
    offers.length > 0 ? `${offers.length} ${offers.length === 1 ? "offer" : "offers"}` : null,
    events.length > 0 ? `${events.length} upcoming ${events.length === 1 ? "event" : "events"}` : null,
    place.description,
  ]);
  const noindex = place.business_status === "CLOSED_PERMANENTLY";
  if (noindex || !place.name) return { description, noindex, jsonLd: null };

  const url = absoluteUrl(`/place/${place.id}`);
  const location = geoPlace(place.name, place.address, place.lat, place.lng);
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": placeSchemaType(place.category),
    "@id": url,
    name: place.name,
    description: place.description ?? description,
    url,
    image: place.image_url ? [place.image_url] : undefined,
    address: location?.address,
    geo: location?.geo,
    telephone: place.phone ?? undefined,
    sameAs: place.website ? [place.website] : undefined,
    priceRange: place.price_range ?? undefined,
    openingHoursSpecification:
      place.opening_hours && place.opening_hours.length > 0
        ? place.opening_hours.map((p) => ({
            "@type": "OpeningHoursSpecification",
            dayOfWeek: `https://schema.org/${SCHEMA_DAYS[p.day]}`,
            opens: p.open,
            closes: p.close,
          }))
        : undefined,
    // Offers made here link to their own pages, where the full Offer lives.
    // Upcoming events are left out: Google reads a nested Event as an Event
    // rich result and flags each one missing a location, and each event's own
    // page already carries its full Event markup.
    makesOffer:
      offers.length > 0
        ? offers.map((h) => ({
            "@type": "Offer",
            name: h.title,
            url: absoluteUrl(`/happening/${h.id}`),
            ...(h.is_free === true ? { price: 0, priceCurrency: h.currency ?? "GBP" } : {}),
          }))
        : undefined,
  };
  return { description, noindex, jsonLd };
}
