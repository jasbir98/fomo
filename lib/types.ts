// Fomo v1.2 — DB types mirroring supabase/archive/schema.sql + supabase/archive/add_auth_identity.sql
// + supabase/archive/harden_rls.sql EXACTLY (snake_case). Every domain table row is
// scoped by `user_id` (an auth.users id), not the old device_id — see
// plan-v1.2-accounts.md §A.5. Nullable Postgres columns are typed `T | null`.
// See lib/db/*.ts for typed CRUD built on these.

import type { FamilyFit } from "@/lib/happenings/types";

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
  /** "Big on-sale alerts" — see supabase/archive/add_push_alerts.sql. When true,
   *  the onsale-alerts Edge Function pushes this user for any high
   *  sellout_risk happening whose booking just opened, with no per-item
   *  opt-in required. */
  big_onsale_alerts: boolean;
}

// user_id is filled by the `default auth.uid()` column default (see
// supabase/archive/add_auth_identity.sql) — never required from the caller.
export type ProfileInsert = Partial<Omit<Profile, "user_id">>;
export type ProfileUpdate = Partial<Omit<Profile, "user_id">>;

// ============================================================================
// CHAT MESSAGES
// ============================================================================
export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  // Chat history is scoped by `user_id` (RLS's own_rows policy). See lib/db/chat.ts.
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
  // add_places_ranking_signals.sql — structured hours:
  // [{ day: 0-6 (0=Sunday), open: "HH:MM", close: "HH:MM" }].
  opening_hours: OpeningHoursPeriod[] | null;
  // Mention count from the (now-removed) reels pipeline's place linkage.
  // Populated by the mention-crossref script, not hand-edited; no longer
  // grows post-2026-09 cleanup since social_posts is gone.
  mention_count: number;
  mention_sources: unknown; // jsonb array of { type, id }
  // Cached, pipeline-written one-line opinion ("Queue starts at nine").
  // Never generated per request — see plan-v1-home-pivot.md §9.7.
  detail_line: string | null;
  // Hero-eligibility gate. Only 'ok' can render the Home hero photo; 'thin'
  // is rail-eligible only; 'none'/null never render as a photo.
  image_quality: "ok" | "thin" | "none" | null;
  // add_enrichment_columns.sql — Google Places facts. Google-owned: refreshed
  // monthly, cleared if older than 30 days (google_fetched_at). The place ID
  // (google_place_id) is exempt and kept forever.
  website: string | null;
  phone: string | null;
  /** Number of Google ratings behind `rating`. */
  google_rating_count: number | null;
  /** Display text, e.g. "£10–20". */
  price_range: string | null;
  /** OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY. */
  business_status: string | null;
  google_maps_uri: string | null;
  /** Google's AI summary — show only together with `google_summary_disclosure`. */
  google_summary: string | null;
  google_summary_disclosure: string | null;
  google_fetched_at: string | null;
  /** add_family_fit.sql — "kids" | "all_ages" | null. Optional: absent before that SQL ran. Read via lib/happenings/family.ts. */
  family_fit?: FamilyFit | null;
  /** add_place_radar.sql: "Under the radar" editorial layer. Optional: absent before that SQL ran. See lib/radar. */
  radar_why?: string | null;
  radar_picked_at?: string | null;
  /** The Monday (YYYY-MM-DD) of the week this pick is featured, if any. */
  radar_featured_week?: string | null;
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
// EVENTS (add_events.sql) — shared, read-only-to-clients cache of live
// time-bound events (Skiddle, Ticketmaster), no user_id. Mirrors `places`'
// shared-cache shape: rows are upserted by provider fetch code, deduped on
// (provider, provider_event_id).
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
  /**
   * Lifecycle (supabase/add_event_lifecycle.sql). Optional because rows read
   * before that SQL has been applied don't carry it; treat missing as "active".
   * The feed lists only 'active'; detail pages and saved items resolve any status.
   */
  status?: EventStatus;
  /** add_family_fit.sql — "kids" | "all_ages" | null. Optional: absent before that SQL ran. Read via lib/happenings/family.ts. */
  family_fit?: FamilyFit | null;
  /**
   * The linked venue (`place_id` -> places), joined by lib/db/events.ts. List
   * reads carry only `image_url` (all a card needs); single reads (detail page)
   * add the name / address / website / Maps link. Absent or null when the
   * event isn't linked to a venue. See scripts/sources/core/venues.mjs.
   */
  place?: EventVenue | null;
}

export interface EventVenue {
  image_url: string | null;
  name?: string | null;
  address?: string | null;
  website?: string | null;
  google_maps_uri?: string | null;
}

export type EventStatus = "active" | "cancelled" | "gone" | "expired";

export type EventItemInsert = Omit<EventItem, "id" | "created_at">;
export type EventItemUpdate = Partial<
  Omit<EventItem, "id" | "provider" | "provider_event_id" | "created_at">
>;

// ============================================================================
// CARD SUBJECT TYPES — what a saved item or card can point at. Trimmed to
// the kinds Fomo actually renders (2026-09 cleanup dropped `experience`,
// `reel`, `itinerary_item` and `practicality` along with the features that
// produced them) — see lib/db/saved.ts's GET /api/saved resolver, which
// skips any unknown type (supabase/archive/drop_legacy.sql deleted the
// rows of those old types).
// ============================================================================
export type CardSubjectType = "place" | "event" | "happening";

// ============================================================================
// SAVED ITEMS (add_now_ranker_tables.sql) — user-scoped shortlist. The
// recall mechanism a ranked, ephemeral Home needs.
// ============================================================================
export interface SavedItem {
  id: string;
  user_id: string;
  subject_type: CardSubjectType;
  subject_id: string;
  note: string | null;
  created_at: string;
}

export type SavedItemInsert = Omit<SavedItem, "id" | "created_at" | "user_id">;
