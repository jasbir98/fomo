/**
 * Shared live-fetch-and-cache pipeline for experiences, extracted from
 * app/api/experiences/route.ts so every caller (the HTTP route, Home's
 * ranker context builder, and the chip-tap discover surface) gets live
 * provider data instead of only ever reading whatever happens to already be
 * cached.
 *
 * Viator + GetYourGuide product search in parallel (Promise.allSettled — one
 * provider failing must never blank out the other's results) → merge
 * successes → upsert into the `experiences` table (dedupe on
 * provider,provider_product_id) → return the cached rows (with real Supabase
 * ids). Always resolves (never throws); degrades to whatever's cached when
 * both providers come up empty, and to synthetic rows when the cache upsert
 * itself fails.
 */
import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { listExperiencesByDestination } from "@/lib/db/experiences";
import type { Experience } from "@/lib/types";
import { geocodeDestination, type Center } from "@/lib/places/geocode";
import {
  searchViatorExperiences,
  ViatorError,
  type MappedExperience as ViatorMappedExperience,
} from "@/lib/experiences/viator";
import { searchGetYourGuideExperiences } from "@/lib/experiences/getyourguide";
import type { Db } from "@/lib/supabase/types";

const DEFAULT_LIMIT = 24;

// The two adapters each define their own local MappedExperience type (by
// design — see getyourguide.ts's file comment) that differ slightly in
// nullability (`source`/`fetched_at` are non-null in Viator's, nullable in
// GetYourGuide's). Merge against this looser shape so results from either
// provider can live in one array without a cast at each push site.
type MappedExperience = Omit<ViatorMappedExperience, "source" | "fetched_at"> & {
  source: string | null;
  fetched_at: string | null;
};

export interface GetExperiencesForDestinationOpts {
  destination: string;
  /**
   * Pre-resolved map center, if the caller already geocoded the destination
   * (e.g. the HTTP route, which also returns `center` in its response).
   * When omitted, this function geocodes the destination itself so callers
   * that don't otherwise need a center (Home's ranker context, discover)
   * don't have to duplicate that step.
   */
  center?: Center | null;
  q?: string;
  category?: string;
  limit?: number;
  offset?: number;
}

export interface GetExperiencesForDestinationResult {
  center: Center | null;
  experiences: Experience[];
  degraded?: string;
}

/** Build a full Experience from a live-mapped result (fallback when the DB cache is unavailable). */
function syntheticExperience(m: MappedExperience): Experience {
  return {
    id: `${m.provider}:${m.provider_product_id}`,
    provider: m.provider,
    provider_product_id: m.provider_product_id,
    title: m.title,
    category: m.category,
    rating: m.rating,
    review_count: m.review_count,
    price_from: m.price_from,
    currency: m.currency,
    duration_label: m.duration_label,
    image_url: m.image_url,
    description: m.description,
    destination: m.destination,
    city: m.city,
    country: m.country,
    lat: m.lat,
    lng: m.lng,
    booking_url: m.booking_url,
    source: m.source,
    fetched_at: m.fetched_at,
    // Experience.created_at is non-null; fall back to "now" in the
    // (currently impossible in practice, but type-legal) case a mapper
    // omitted fetched_at.
    created_at: m.fetched_at ?? new Date().toISOString(),
  };
}

export async function getExperiencesForDestination(
  db: Db,
  opts: GetExperiencesForDestinationOpts
): Promise<GetExperiencesForDestinationResult> {
  const { destination, q, category } = opts;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const offset = opts.offset ?? 0;

  const center = opts.center !== undefined ? opts.center : await geocodeDestination(destination);

  // 1. Fetch live experiences from both providers in parallel. Use
  // allSettled (not all) — one provider throwing must never blank out the
  // other's results.
  const [viatorResult, gygResult] = await Promise.allSettled([
    searchViatorExperiences({ destination, q, category, limit, offset, center }),
    searchGetYourGuideExperiences({ destination, q, category, limit, offset, center }),
  ]);

  const mapped: MappedExperience[] = [];

  if (viatorResult.status === "fulfilled") {
    mapped.push(...viatorResult.value);
  } else {
    const reason =
      viatorResult.reason instanceof ViatorError ? "viator-error" : "viator-error";
    console.error(
      `[experiences/getForDestination] viator search failed (${reason})`,
      viatorResult.reason
    );
  }

  if (gygResult.status === "fulfilled") {
    mapped.push(...gygResult.value);
  } else {
    console.error(
      "[experiences/getForDestination] getyourguide search failed (getyourguide-error)",
      gygResult.reason
    );
  }

  // 2. Both providers came up empty (failed, unconfigured, or genuinely no
  // results). On the FIRST page only, fall back to whatever's already
  // cached for this destination (no seed data for this new feature, unlike
  // places, so this cache fallback is the only degrade path there). On a
  // later page (offset > 0) an empty result just means pagination has
  // reached the end — the cache dump doesn't paginate, so falling back to
  // it here would re-return the same full first-page set forever instead of
  // signaling "no more results" to the infinite-scroll UI.
  if (mapped.length === 0) {
    if (offset > 0) {
      return { center, experiences: [] };
    }
    let cached: Experience[] = [];
    try {
      cached = await listExperiencesByDestination(db, destination);
    } catch (err) {
      console.error("[experiences/getForDestination] cache fallback lookup failed", err);
    }
    if (cached.length > 0) {
      return { center, experiences: cached, degraded: "no-live-results" };
    }
    return { center, experiences: [], degraded: "no-results" };
  }

  // 3. Cache into `experiences` (dedupe on provider,provider_product_id) and
  // return rows with ids.
  //
  // Split into two upsert batches by whether we resolved a photo — identical
  // to the places route's rowsWithPhoto/rowsWithoutPhoto trick (see
  // app/api/places/route.ts): supabase-js's upsert() writes every key present
  // in the row object on conflict, so `image_url` has to be *omitted* (not
  // just falsy) for rows where this fetch found no photo, letting a
  // previously-cached image_url survive rather than being clobbered to null.
  const rowsWithPhoto = mapped.filter((m) => m.image_url != null);
  const rowsWithoutPhoto = mapped
    .filter((m) => m.image_url == null)
    .map(({ image_url: _image_url, ...rest }) => rest);

  // Catalog writes always go through the service-role client — RLS's
  // catalog policy (supabase/harden_rls.sql) is select-only for
  // anon/authenticated from this phase on.
  const admin = supabaseAdmin();
  const results = await Promise.all([
    rowsWithPhoto.length > 0
      ? admin
          .from("experiences")
          .upsert(rowsWithPhoto, { onConflict: "provider,provider_product_id" })
          .select("*")
      : Promise.resolve({ data: [] as Experience[], error: null }),
    rowsWithoutPhoto.length > 0
      ? admin
          .from("experiences")
          .upsert(rowsWithoutPhoto, { onConflict: "provider,provider_product_id" })
          .select("*")
      : Promise.resolve({ data: [] as Experience[], error: null }),
  ]);

  const error = results[0].error ?? results[1].error;
  const data = error ? null : [...(results[0].data ?? []), ...(results[1].data ?? [])];

  if (error || !data) {
    // Migration not run yet (missing table / unique index) — still render
    // the live results as synthetic Experience rows so the feature works
    // ahead of the migration landing.
    const rows: unknown = data; // narrowed to null in this branch; widen for logging
    console.error(
      `[experiences/getForDestination] experiences cache upsert failed (run supabase/add_experiences.sql) ` +
        `code=${error?.code ?? "<none>"} message=${error?.message ?? "<none>"} ` +
        `details=${error?.details ?? "<none>"} hint=${error?.hint ?? "<none>"} ` +
        `dataIsNull=${rows === null} dataLength=${Array.isArray(rows) ? rows.length : "n/a"}`
    );
    return {
      center,
      experiences: mapped.map(syntheticExperience),
      degraded: "cache-unavailable",
    };
  }

  return { center, experiences: data as Experience[] };
}
