#!/usr/bin/env node
/**
 * backfill-trip-geo.mjs — one-off backfill for `trips` rows created before
 * Phase 3 (Trip geo capture, plan-v1.2-accounts.md) added `lat`/`lng`/
 * `country_code`/`timezone`/`place_label`. New trips get these from
 * POST /api/trips/resolve at creation time (app/api/trips/resolve/route.ts);
 * this script re-runs the same resolution against every existing trip's
 * `destination` string and PATCHes the columns in.
 *
 * Duplicates (rather than imports) the resolve logic from
 * lib/places/geocode.ts / lib/weather.ts / lib/places/label.ts — those are
 * Next.js `server-only` TS modules with no plain-Node entry point, and the
 * rest of this repo's one-off scripts (see promote-japan-places.mjs) are
 * plain .mjs hitting REST directly rather than pulling in a TS build step.
 * If you change the resolve logic in those app modules, mirror the change
 * here too.
 *
 * Uses the Supabase service-role key (bypasses RLS) so it can backfill
 * every user's trips, not just one caller's — this can NOT use the anon
 * key the other pipeline scripts use, since `trips` RLS scopes reads/writes
 * to auth.uid() (see supabase/harden_rls.sql).
 *
 * Idempotent: only selects trips missing place_label, so re-running after
 * a partial failure (e.g. rate-limited mid-run) is safe and just picks up
 * where it left off. A trip whose destination fails to geocode gets
 * place_label set (pure string logic, can't fail) but lat/lng/country_code/
 * timezone stay null — it will NOT be re-selected on a re-run since
 * place_label is what's checked. Delete place_label for a row if you want
 * to force a retry.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-trip-geo.mjs
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server-only,
 * see lib/supabase/admin.ts), and NEXT_PUBLIC_MAPBOX_TOKEN (same var the app
 * uses, see lib/places/geocode.ts). Open-Meteo needs no key.
 *
 * Run this ONCE, after both supabase/add_trip_persona.sql has been applied
 * (so the columns exist) and this phase's app code is deployed.
 */

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "[backfill-trip-geo] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
      "Run with: node --env-file=.env.local scripts/backfill-trip-geo.mjs"
  );
  process.exit(1);
}
if (!mapboxToken) {
  console.warn(
    "[backfill-trip-geo] Missing NEXT_PUBLIC_MAPBOX_TOKEN — lat/lng/country_code will stay " +
      "null for every row (place_label and, where geocoding isn't needed, nothing else, " +
      "still get backfilled)."
  );
}

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

async function rest(path, options = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${options.method ?? "GET"} ${path} → ${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Mirrors lib/places/label.ts's placeLabel().
function placeLabel(destination) {
  return destination?.split(",")[0]?.trim() || null;
}

// Mirrors lib/places/geocode.ts's geocodeSuggestions() country-code
// extraction (limit=1, same context[]-parsing).
async function geocodeTop(destination) {
  if (!mapboxToken) return null;
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/` +
    `${encodeURIComponent(destination)}.json` +
    `?access_token=${encodeURIComponent(mapboxToken)}` +
    `&autocomplete=true&types=place,locality,region,country&limit=1&language=en`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[backfill-trip-geo] mapbox geocode failed for "${destination}": ${res.status}`);
      return null;
    }
    const data = await res.json();
    const f = data.features?.[0];
    const c = f?.center;
    if (!f || !c || c.length !== 2) return null;
    const [lng, lat] = c;
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    const countryCtx = f.context?.find((entry) => entry.id?.startsWith("country."));
    const countryCode = countryCtx?.short_code ? countryCtx.short_code.toUpperCase() : null;
    return { lat, lng, countryCode };
  } catch (err) {
    console.error(`[backfill-trip-geo] mapbox geocode error for "${destination}"`, err);
    return null;
  }
}

// Mirrors lib/weather.ts's timezone extraction from Open-Meteo.
async function timezoneFor(lat, lng) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=weather_code&timezone=auto&forecast_days=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.timezone ?? null;
  } catch (err) {
    console.error(`[backfill-trip-geo] open-meteo error for ${lat},${lng}`, err);
    return null;
  }
}

async function resolveTripGeo(destination) {
  const place_label = placeLabel(destination);
  if (!destination) return { lat: null, lng: null, country_code: null, timezone: null, place_label };

  const top = await geocodeTop(destination);
  const timezone = top ? await timezoneFor(top.lat, top.lng) : null;

  return {
    lat: top?.lat ?? null,
    lng: top?.lng ?? null,
    country_code: top?.countryCode ?? null,
    timezone,
    place_label,
  };
}

async function fetchTripsMissingGeo() {
  // PostgREST caps a single response at 1000 rows by default — paginate
  // defensively even though a single user's trip count is expected to be
  // small (see promote-japan-places.mjs, which hit this cap for real).
  const PAGE_SIZE = 1000;
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await rest(
      `trips?place_label=is.null&select=id,destination&limit=${PAGE_SIZE}&offset=${offset}`
    );
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function main() {
  const trips = await fetchTripsMissingGeo();
  console.log(`[backfill-trip-geo] ${trips.length} trip(s) missing place_label`);

  let ok = 0;
  let failed = 0;
  for (const trip of trips) {
    try {
      const geo = await resolveTripGeo(trip.destination ?? "");
      await rest(`trips?id=eq.${trip.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(geo),
      });
      ok++;
      console.log(
        `[backfill-trip-geo] ${trip.id} "${trip.destination}" -> ` +
          `${geo.place_label ?? "?"} (${geo.country_code ?? "no country"}, ${geo.timezone ?? "no tz"})`
      );
    } catch (err) {
      failed++;
      console.error(`[backfill-trip-geo] failed for trip ${trip.id} "${trip.destination}"`, err);
    }
    // Be polite to Mapbox/Open-Meteo — this is a one-off script, not a hot path.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log(`[backfill-trip-geo] done: ${ok} updated, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
