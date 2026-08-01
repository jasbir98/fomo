// Roameo v0 — DB types mirroring supabase/schema.sql EXACTLY (snake_case).
// Every domain table row includes device_id. Nullable Postgres columns are
// typed `T | null`. See lib/db/*.ts for typed CRUD built on these.

// ============================================================================
// PROFILES
// ============================================================================
export interface NotificationSettings {
  trip_reminders: boolean;
  weekly_digest: boolean;
  ai_suggestions: boolean;
}

export interface PrivacySettings {
  personalized_recommendations: boolean;
  precise_location: boolean;
  share_usage_data: boolean;
}

export interface Profile {
  device_id: string;
  display_name: string | null;
  avatar_url: string | null;
  membership_tier: string | null;
  created_at: string;
  notification_settings: NotificationSettings;
  privacy_settings: PrivacySettings;
}

export type ProfileInsert = Partial<Omit<Profile, "device_id">> & {
  device_id: string;
};
export type ProfileUpdate = Partial<Omit<Profile, "device_id">>;

// ============================================================================
// TRAVEL PREFERENCES
// ============================================================================
export interface TravelPreferences {
  device_id: string;
  luxury_backpacker: number | null;
  planned_spontaneous: number | null;
  foodie_utilitarian: number | null;
  interests: string[];
  dietary: string[];
  mobility: string[];
  languages: string[];
}

export type TravelPreferencesInsert = Partial<
  Omit<TravelPreferences, "device_id">
> & { device_id: string };
export type TravelPreferencesUpdate = Partial<
  Omit<TravelPreferences, "device_id">
>;

// ============================================================================
// ROAMEO RULES
// ============================================================================
export interface RoameoRules {
  device_id: string;
  rules_text: string | null;
  quick_chips: string[];
}

export type RoameoRulesInsert = Partial<Omit<RoameoRules, "device_id">> & {
  device_id: string;
};
export type RoameoRulesUpdate = Partial<Omit<RoameoRules, "device_id">>;

// ============================================================================
// TRIPS
// ============================================================================
export interface Trip {
  id: string;
  device_id: string;
  name: string | null;
  destination: string | null;
  start_date: string | null; // date, e.g. "2026-03-28"
  end_date: string | null;
  status: string | null;
  cover_image_url: string | null;
  created_at: string;
}

export type TripInsert = Partial<Omit<Trip, "id" | "device_id" | "created_at">> & {
  device_id: string;
};
export type TripUpdate = Partial<
  Omit<Trip, "id" | "device_id" | "created_at">
>;

// ============================================================================
// ITINERARY ITEMS
// ============================================================================
export interface ItineraryItem {
  id: string;
  trip_id: string;
  device_id: string;
  day_date: string | null;
  time_label: string | null;
  category: string | null;
  title: string | null;
  location: string | null;
  weather_alert: boolean;
  color_tag: string | null;
  created_at: string;
  // add_itinerary_place_id.sql — links back to the `places` row this item
  // was created from, so the item detail view can show a photo/description.
  // Null for manually-created items (no underlying place to reference).
  place_id: string | null;
  // add_experiences.sql — links back to the `experiences` row this item was
  // booked/created from (a bookable Viator/GetYourGuide tour). Mutually
  // exclusive with place_id in practice, but both are nullable at the DB
  // level since manually-created items reference neither.
  experience_id: string | null;
  // add_itinerary_times.sql — best-effort parsed clock time, backfilled from
  // time_label + day_date. Null for items whose time_label didn't parse
  // (treated as unscheduled by the ranker — never guessed). See lib/now/.
  starts_at: string | null;
  duration_minutes: number | null;
}

export type ItineraryItemInsert = Partial<
  Omit<ItineraryItem, "id" | "device_id" | "created_at">
> & { device_id: string; trip_id: string };
export type ItineraryItemUpdate = Partial<
  Omit<ItineraryItem, "id" | "device_id" | "trip_id" | "created_at">
>;

// ============================================================================
// CHAT MESSAGES
// ============================================================================
export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  trip_id: string;
  device_id: string;
  role: ChatRole;
  mode: string | null;
  content: unknown; // jsonb
  created_at: string;
}

export type ChatMessageInsert = {
  device_id: string;
  trip_id: string;
  role: ChatRole;
  mode?: string | null;
  content?: unknown;
};

// ============================================================================
// PLACES (shared, read-only, no device_id)
// ============================================================================
export interface Place {
  id: string;
  name: string | null;
  category: string | null;
  rating: number | null;
  image_url: string | null;
  distance_label: string | null;
  tips: unknown; // jsonb array
  reviews: unknown; // jsonb array
  hours: string | null;
  station: string | null;
  badges: string[];
  google_place_id: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  price_level: number | null;
  destination: string | null;
  source: string | null;
  fetched_at: string | null;
  // Japan places pipeline (add_japan_places_pipeline.sql) — populated for
  // curated seed-japan-pipeline rows, null for live Google-cached rows.
  city: string | null;
  prefecture: string | null;
  country: string | null;
  description: string | null;
  last_verified_at: string | null;
  hours_status: "known" | "unknown" | "stale" | null;
  // add_places_ranking_signals.sql — see lib/now/ (the "right now" ranker).
  // Structured hours: [{ day: 0-6 (0=Sunday), open: "HH:MM", close: "HH:MM" }].
  opening_hours: OpeningHoursPeriod[] | null;
  // Reel-mention count, the v1 Best-of-the-City floor (see local_pick in
  // lib/now/generators.ts). Populated by the mention-crossref script, not
  // hand-edited.
  mention_count: number;
  mention_sources: unknown; // jsonb array of { type, id }
  // Cached, pipeline-written one-line opinion ("Queue starts at nine").
  // Never generated per request — see plan-v1-home-pivot.md §9.7.
  detail_line: string | null;
  // Hero-eligibility gate. Only 'ok' can render the Home hero photo; 'thin'
  // is rail-eligible only; 'none'/null never render as a photo.
  image_quality: "ok" | "thin" | "none" | null;
}

export interface OpeningHoursPeriod {
  day: number; // 0-6, 0 = Sunday
  open: string; // "HH:MM", 24h
  close: string; // "HH:MM", 24h — may be past midnight relative to `open`
}

// ============================================================================
// PLACE PHOTOS (add_japan_places_pipeline.sql) — multi-photo carousel source
// for a place's detail page; a place with no rows here falls back to its
// single Place.image_url.
// ============================================================================
export interface PlacePhoto {
  id: string;
  place_id: string;
  url: string;
  credit: string;
  license: string;
  source_url: string;
  display_order: number;
  created_at: string;
}

// ============================================================================
// SOCIAL POSTS (shared, read-only, no device_id)
// ============================================================================
export interface SocialPost {
  id: string;
  author_handle: string | null;
  avatar_url: string | null;
  image_url: string | null;
  caption: string | null;
  likes: number | null;
  location: string | null;
  // Reel fields (added by add_social_video_columns.sql) — populated by the
  // offline Playwright scraper (scraper/), null for the original seed rows.
  platform: string | null;
  video_url: string | null;
  thumbnail_url: string | null;
  destination: string | null;
  place_id: string | null;
}

// ============================================================================
// EXPERIENCES (add_experiences.sql) — shared, read-only-to-clients cache of
// bookable tours/activities (Viator, GetYourGuide), no device_id. Mirrors
// `places`' shared-cache shape: rows are upserted by provider fetch/sync
// code, deduped on (provider, provider_product_id).
// ============================================================================
// ============================================================================
// EVENTS (add_events.sql) — shared, read-only-to-clients cache of live
// time-bound events (Skiddle, Ticketmaster), no device_id. Mirrors
// `experiences`' shared-cache shape: rows are upserted by provider fetch
// code, deduped on (provider, provider_event_id).
//
// Named `EventItem`, not `Event`, deliberately: a global DOM `Event`
// interface already exists, and shadowing it inside client components that
// also handle pointer/keyboard events is a real, live footgun.
// ============================================================================
export interface EventItem {
  id: string;
  provider: string;
  provider_event_id: string;
  name: string;
  description: string | null;
  category: string | null;
  image_url: string | null;
  ticket_url: string | null;
  starts_at: string;
  ends_at: string | null;
  venue_name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  city: string | null;
  country: string | null;
  is_free: boolean | null;
  price_from: number | null;
  currency: string | null;
  destination: string | null;
  place_id: string | null;
  source: string | null;
  fetched_at: string | null;
  created_at: string;
}

export type EventItemInsert = Omit<EventItem, "id" | "created_at">;
export type EventItemUpdate = Partial<
  Omit<EventItem, "id" | "provider" | "provider_event_id" | "created_at">
>;

export interface Experience {
  id: string;
  provider: string;
  provider_product_id: string;
  title: string;
  category: string | null;
  rating: number | null;
  review_count: number | null;
  price_from: number | null;
  currency: string | null;
  duration_label: string | null;
  image_url: string | null;
  description: string | null;
  destination: string | null;
  city: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  booking_url: string | null;
  source: string | null;
  fetched_at: string | null;
  created_at: string;
}

// ============================================================================
// CARD SIGNALS (add_now_ranker_tables.sql) — device-scoped. The ranker's
// only feedback channel: every shown/opened/dismissed("Nah")/saved/planned
// event on a ranked card. See lib/now/.
// ============================================================================
export type CardSubjectType = "place" | "event" | "experience" | "itinerary_item" | "reel";
export type CardSignalAction = "shown" | "opened" | "dismissed" | "saved" | "planned";

export interface CardSignal {
  id: string;
  device_id: string;
  trip_id: string | null;
  card_type: string; // generator name, e.g. "closing_soon"
  subject_type: CardSubjectType;
  subject_id: string;
  action: CardSignalAction;
  created_at: string;
}

export type CardSignalInsert = Omit<CardSignal, "id" | "created_at">;

// ============================================================================
// SAVED ITEMS (add_now_ranker_tables.sql) — device-scoped shortlist. The
// recall mechanism a ranked, ephemeral Home needs (plan-v1-home-pivot.md §8).
// ============================================================================
export interface SavedItem {
  id: string;
  device_id: string;
  trip_id: string | null;
  subject_type: CardSubjectType;
  subject_id: string;
  note: string | null;
  created_at: string;
}

export type SavedItemInsert = Omit<SavedItem, "id" | "created_at">;

// ============================================================================
// DEVICE LOCATION (add_now_ranker_tables.sql) — coarse last-known location,
// one row per device. Not a tracking table — see the comment in the
// migration. Written/deleted by lib/now/location.ts.
// ============================================================================
export interface DeviceLocation {
  device_id: string;
  lat: number | null;
  lng: number | null;
  updated_at: string;
}

// ============================================================================
// ARRIVAL TIPS (add_now_ranker_tables.sql) — shared, hand-authored,
// read-only. Backs the cold-start Home hero (plan-v1-home-pivot.md §4.5).
// ============================================================================
export interface ArrivalTip {
  id: string;
  country: string;
  city: string | null;
  headline: string;
  detail: string;
  applies_hours_from: number;
  applies_hours_to: number;
}
