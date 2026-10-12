/** Fixture builders shared by the lib/finds tests. Not a test file itself (no `.test.` in the name), so the runner doesn't execute it. */
import type { Happening } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";
import type { FindRow } from "@/lib/finds/types";

/** Wed 14 Oct 2026, 13:00 BST. */
export const NOW = new Date("2026-10-14T12:00:00Z");

export function happening(over: Partial<Happening> & { id: string }): Happening {
  return {
    slug: over.id,
    title: `Happening ${over.id}`,
    summary: null,
    kind: "deal",
    category: "food",
    scope: "city",
    editorial_tag: null,
    saving_label: null,
    saving_amount: null,
    currency: "GBP",
    is_free: false,
    promo_code: null,
    redemption_note: null,
    eligibility: "anyone",
    eligibility_note: null,
    allowance_note: null,
    starts_at: null,
    ends_at: null,
    recurrence: { type: "once" },
    time_note: null,
    booking_opens_at: null,
    sellout_risk: null,
    sellout_note: null,
    venue_name: "Some Bar",
    address: null,
    district: null,
    city: "Edinburgh",
    region: "Scotland",
    country_code: "GB",
    lat: null,
    lng: null,
    place_id: null,
    image_url: "https://example.com/i.jpg",
    image_quality: null,
    booking_url: null,
    cta_label: null,
    source_name: "test",
    source_url: "https://example.com",
    verified_at: "2026-10-10T00:00:00Z",
    confidence: "high",
    status: "live",
    priority: 50,
    price_text: null,
    includes: null,
    enrich_sources: null,
    enriched_at: null,
    created_at: null,
    updated_at: null,
    ...over,
  };
}

export function event(over: Partial<EventItem> & { id: string }): EventItem {
  return {
    provider: "skiddle",
    provider_event_id: over.id,
    name: `Event ${over.id}`,
    description: null,
    category: "music",
    image_url: "https://example.com/e.jpg",
    ticket_url: null,
    starts_at: "2026-10-16T19:00:00Z",
    ends_at: null,
    venue_name: "Some Venue",
    address: null,
    lat: null,
    lng: null,
    city: "Edinburgh",
    country: "GB",
    is_free: false,
    price_from: 10,
    currency: "GBP",
    destination: null,
    place_id: null,
    source: null,
    fetched_at: null,
    created_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

export function findRow(over: Partial<FindRow> & { id: string }): FindRow {
  return {
    subject_type: "happening",
    subject_id: over.id,
    why: "why",
    fomo_level: 3,
    score: 50,
    status: "live",
    week_of: "2026-10-16",
    created_at: "2026-10-12T00:00:00Z",
    approved_at: "2026-10-12T00:00:00Z",
    ...over,
  };
}
