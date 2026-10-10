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
import type { EventItem } from "@/lib/types";
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
 * Google asks for. Nothing comes back without a venue name.
 */
function venueOrganizer(venueName: string | null, website?: string | null) {
  if (!venueName) return undefined;
  return { "@type": "Organization", name: venueName, ...(website ? { url: website } : {}) };
}

export function happeningSeo(h: Happening, now: Date = new Date()): DetailSeo {
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
      organizer: venueOrganizer(h.venue_name),
      image: h.image_url ? [h.image_url] : undefined,
      url: absoluteUrl(`/happening/${h.id}`),
      offers:
        h.is_free === true
          ? {
              "@type": "Offer",
              price: 0,
              priceCurrency: h.currency ?? "GBP",
              url: h.booking_url ?? h.source_url,
              availability: "https://schema.org/InStock",
              validFrom: h.booking_opens_at ?? undefined,
            }
          : undefined,
    };
  }
  return { description, noindex, jsonLd };
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
      organizer: venueOrganizer(e.place?.name ?? e.venue_name, e.place?.website),
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
