/**
 * Shared constants + env reading for scripts/daily-sources.mjs and its
 * adapters. Everything here is read once at import time; run the script via
 * `node --env-file=.env.local` so the env is populated before this loads.
 */

export const DESTINATION = "Edinburgh, Scotland, United Kingdom";

// Rolling window: how far ahead we keep events. The API adapters (Skiddle,
// Ticketmaster) request exactly this window and core/validate.mjs drops any
// row starting later (reason `beyond_window`).
export const LOOKAHEAD_DAYS = 31;
// Deprecated alias — adapters should import LOOKAHEAD_DAYS.
export const PROACTIVE_LOOKAHEAD_DAYS = LOOKAHEAD_DAYS;
// Search radius around the Edinburgh centre for the API adapters.
export const PROACTIVE_RADIUS_MILES = 10; // brief: "Edinburgh ... radius ~10 miles"

export const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
export const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
