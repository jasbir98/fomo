// Fomo v1.2 — DB types mirroring supabase/schema.sql + supabase/add_auth_identity.sql
// + supabase/harden_rls.sql EXACTLY (snake_case). Every domain table row is
// scoped by `user_id` (an auth.users id), not the old device_id — see
// plan-v1.2-accounts.md §A.5. Nullable Postgres columns are typed `T | null`.
// See lib/db/*.ts for typed CRUD built on these.

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
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  membership_tier: string | null;
  created_at: string;
  notification_settings: NotificationSettings;
  privacy_settings: PrivacySettings;
  /** "Big on-sale alerts" — see supabase/add_push_alerts.sql. When true,
   *  the onsale-alerts Edge Function pushes this user for any high
   *  sellout_risk happening whose booking just opened, with no per-item
   *  opt-in required. */
  big_onsale_alerts: boolean;
}

// user_id is filled by the `default auth.uid()` column default (see
// supabase/add_auth_identity.sql) — never required from the caller.
export type ProfileInsert = Partial<Omit<Profile, "user_id">>;
export type ProfileUpdate = Partial<Omit<Profile, "user_id">>;

// ============================================================================
// TRAVEL PREFERENCES
// ============================================================================
export interface TravelPreferences {
  user_id: string;
  dietary: string[];
  languages: string[];
  // Person-scoped persona (Phase 4, supabase/add_person_persona.sql) — written
  // by /onboarding/taste and /onboarding/rhythm (and their shared edit-mode
  // wrapper, app/setup/travel-dna). All nullable/optional: every onboarding
  // screen after /where is skippable, and Phase 5's ranker treats a null the
  // same as "no signal", never as a default.
  budget_band: string | null; // shoestring | middle | treat
  walk_tolerance: string | null; // high | medium | low
  interest_tags: string[];
  cuisine_tags: string[];
  day_rhythm: string | null; // early | steady | night
  pace: string | null; // packed | balanced | slow
}

export type TravelPreferencesInsert = Partial<Omit<TravelPreferences, "user_id">>;
export type TravelPreferencesUpdate = Partial<Omit<TravelPreferences, "user_id">>;

// ============================================================================
// FOMO RULES
// ============================================================================
export interface FomoRules {
  user_id: string;
  rules_text: string | null;
  quick_chips: string[];
}

export type FomoRulesInsert = Partial<Omit<FomoRules, "user_id">>;
export type FomoRulesUpdate = Partial<Omit<FomoRules, "user_id">>;

// ============================================================================
// TRIPS
// ============================================================================
export interface Trip {
  id: string;
  user_id: string;
  name: string | null;
  destination: string | null;
  start_date: string | null; // date, e.g. "2026-03-28"
  end_date: string | null;
  status: string | null;
  cover_image_url: string | null;
  created_at: string;
  // Geo capture (Phase 3, supabase/add_trip_persona.sql) — resolved once at
  // trip-creation time via POST /api/trips/resolve from the `destination`
  // string. All optional/nullable: Mapbox/Open-Meteo can fail per-destination,
  // and pre-Phase-3 trips won't have these backfilled until
  // scripts/backfill-trip-geo.mjs is run.
  lat: number | null;
  lng: number | null;
  country_code: string | null;
  timezone: string | null;
  place_label: string | null;
  // Trip-scoped persona (Phase 4, supabase/add_trip_persona.sql) — written by
  // /onboarding/stage (plan_stage) and /onboarding/party (party_type,
  // party_size, kid_ages, first_time). `purpose` and `pace_override` have no
  // writer yet (reserved for a later phase). All nullable/optional: onboarding
  // is skippable, and pre-Phase-4 trips won't have these until backfilled.
  plan_stage: string | null; // booked | rough | open
  purpose: string | null; // holiday | work | visiting | event
  party_type: string | null; // solo | couple | friends | family
  party_size: number | null;
  kid_ages: string[]; // under5 | 5to12 | teen
  first_time: boolean | null;
  pace_override: string | null;
}

export type TripInsert = Partial<Omit<Trip, "id" | "user_id" | "created_at">>;
export type TripUpdate = Partial<Omit<Trip, "id" | "user_id" | "created_at">>;

// ============================================================================
// ITINERARY ITEMS
// ============================================================================
export interface ItineraryItem {
  id: string;
  trip_id: string;
  user_id: string;
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
  Omit<ItineraryItem, "id" | "user_id" | "created_at">
> & { trip_id: string };
export type ItineraryItemUpdate = Partial<
  Omit<ItineraryItem, "id" | "user_id" | "trip_id" | "created_at">
>;

// ============================================================================
// CHAT MESSAGES
// ============================================================================
export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  // Nullable + unused since supabase/decouple_chat_from_trips.sql dropped
  // its NOT NULL + FK to `trips` — Fomo has no trips anymore. The column is
  // left in the DB (not dropped), so it stays here for the mirror, but
  // nothing in app code reads or writes it; chat history is scoped by
  // `user_id` (RLS's own_rows policy) instead. See lib/db/chat.ts.
  trip_id: string | null;
  user_id: string;
  role: ChatRole;
  mode: string | null;
  content: unknown; // jsonb
  created_at: string;
}

export type ChatMessageInsert = {
  role: ChatRole;
  mode?: string | null;
  content?: unknown;
};

// ============================================================================
// PLACES (shared, read-only, no user_id)
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
// SOCIAL POSTS (shared, read-only, no user_id)
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
// bookable tours/activities (Viator, GetYourGuide), no user_id. Mirrors
// `places`' shared-cache shape: rows are upserted by provider fetch/sync
// code, deduped on (provider, provider_product_id).
// ============================================================================
// ============================================================================
// EVENTS (add_events.sql) — shared, read-only-to-clients cache of live
// time-bound events (Skiddle, Ticketmaster), no user_id. Mirrors
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
// CARD SIGNALS (add_now_ranker_tables.sql) — user-scoped. The ranker's
// only feedback channel: every shown/opened/dismissed("Nah")/saved/planned
// event on a ranked card. See lib/now/.
// ============================================================================
export type CardSubjectType = "place" | "event" | "experience" | "itinerary_item" | "reel" | "practicality";
export type CardSignalAction = "shown" | "opened" | "dismissed" | "saved" | "planned";

export interface CardSignal {
  id: string;
  user_id: string;
  trip_id: string | null;
  card_type: string; // generator name, e.g. "closing_soon"
  subject_type: CardSubjectType;
  subject_id: string;
  action: CardSignalAction;
  created_at: string;
}

// user_id is filled by the `default auth.uid()` column default — never
// required from the caller (recordCardSignal is called from client
// components, which never know the raw uuid, only the session).
// `trip_id` is also omitted here — Fomo has no trips anymore. The column
// stays in the DB (nullable, unused); lib/db/signals.ts's recordCardSignal
// is the one place that still writes it, always null.
export type CardSignalInsert = Omit<CardSignal, "id" | "created_at" | "user_id" | "trip_id">;

// ============================================================================
// SAVED ITEMS (add_now_ranker_tables.sql) — user-scoped shortlist. The
// recall mechanism a ranked, ephemeral Home needs (plan-v1-home-pivot.md §8).
// ============================================================================
export interface SavedItem {
  id: string;
  user_id: string;
  trip_id: string | null;
  subject_type: CardSubjectType;
  subject_id: string;
  note: string | null;
  created_at: string;
}

// `trip_id` is also omitted here — Fomo has no trips anymore. The column
// stays in the DB (nullable, unused); lib/db/saved.ts's saveItem is the one
// place that still writes it, always null.
export type SavedItemInsert = Omit<SavedItem, "id" | "created_at" | "user_id" | "trip_id">;

// ============================================================================
// USER LOCATION (add_now_ranker_tables.sql; renamed from `device_location` in
// add_auth_identity.sql — see plan-v1.2-accounts.md §A.5) — coarse
// last-known location, one row per user. Not a tracking table — see the
// comment in the migration. Written/deleted by lib/now/location.ts.
// ============================================================================
export interface DeviceLocation {
  user_id: string;
  lat: number | null;
  lng: number | null;
  updated_at: string;
}

// ============================================================================
// ARRIVAL TIPS (add_now_ranker_tables.sql) — shared, hand-authored,
// read-only. Superseded as of Phase 7 (plan-v1.2-accounts.md §E) by
// `country_practicalities` below — lib/db/arrivalTips.ts and every app-code
// reader of this table are gone (lib/now/generators.ts's `arrival` generator
// now reads from ctx.practicalities instead). The `arrival_tips` table and
// supabase/seed_arrival_tips.sql are deliberately left in the DB/repo (no
// drop migration shipped with this phase), so this type stays too, purely
// for documentation/rollback reference — nothing imports it anymore.
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

// ============================================================================
// COUNTRY PRACTICALITIES (add_practicalities.sql) — shared, hand-authored,
// read-only. Backs the "Before you land" / "Getting set up" Home rail
// (plan-v1.2-accounts.md §E) and, via lib/now/generators.ts's `arrival`
// generator, the day-1 Home hero copy. `topic` is a stable literal set — it
// is the key `practicality_dismissals` dismisses on, so it must never drift
// into free text anywhere in the app.
// ============================================================================
export type PracticalityTopic =
  | "connectivity"
  | "money"
  | "transit"
  | "power"
  | "water"
  | "tipping"
  | "safety";

export interface CountryPracticality {
  id: string;
  country_code: string; // ISO-2, joins trips.country_code
  city: string | null; // null = country-wide
  topic: PracticalityTopic;
  headline: string; // <= 8 words
  detail: string;
  chat_seed: string | null; // pre-seeds the "Ask Fomo" chat hand-off
  applies_from_days: number; // relative to trip start_date; negative = before landing
  applies_to_days: number;
  priority: number;
  review_by: string | null; // date
  updated_at: string;
}

// ============================================================================
// PRACTICALITY DISMISSALS (add_practicalities.sql) — user-scoped. "Already
// sorted" per topic, keyed on (user, country, topic) — deliberately NOT on
// trip, so a dismissal survives into a later trip to the same country.
// ============================================================================
export interface PracticalityDismissal {
  user_id: string;
  country_code: string;
  topic: PracticalityTopic;
  dismissed_at: string;
}
