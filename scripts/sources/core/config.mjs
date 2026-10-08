/**
 * Shared constants + env reading for scripts/daily-sources.mjs and its
 * adapters. Everything here is read once at import time; run the script via
 * `node --env-file=.env.local` so the env is populated before this loads.
 */

export const DESTINATION = "Edinburgh, Scotland, United Kingdom";

// Window for the two API adapters (Skiddle, Ticketmaster): how far ahead they
// page, and the search radius around the Edinburgh centre.
export const PROACTIVE_LOOKAHEAD_DAYS = 60;
export const PROACTIVE_RADIUS_MILES = 10; // brief: "Edinburgh ... radius ~10 miles"

export const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
export const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
