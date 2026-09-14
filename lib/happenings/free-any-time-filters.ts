/**
 * Fomo Happenings — Free Any Time page filter taxonomy.
 *
 * Pure, deterministic client-side filtering over `FreeAnyTimeItem[]`
 * (GET /api/feed's already-full `freeAnyTime` array — see
 * lib/happenings/feed-types.ts and app/api/feed/route.ts's `buildFreeAnyTime`).
 * Same "no refetch on a chip tap" principle as
 * lib/happenings/book-early-filters.ts and lib/happenings/groups.ts: the two
 * facets (`typeLabel`, `district`) are precomputed server-side per item, this
 * module only matches against them.
 *
 * Type labels are mapped into ~6 friendly buckets:
 * - "Tours & walks"
 * - "Museums & galleries"
 * - "Parks & views"
 * - "Historic sites"
 * - "Arts & music"
 * - "Markets"
 * - "Other" (for unmapped categories)
 */
import type { FreeAnyTimeItem } from "@/lib/happenings/feed-types";

/** Maps a raw typeLabel to its bucket category. Case-insensitive match on
 *  normalized label and keywords. Returns the bucket name or "Other". */
export function typeToTypeBucket(rawLabel: string | null): string {
  if (!rawLabel) return "Other";

  const normalized = rawLabel.toLowerCase().trim();

  // Tours & walks
  if (
    normalized === "tours" ||
    normalized === "walking route" ||
    normalized === "street" ||
    normalized === "shopping street"
  ) {
    return "Tours & walks";
  }

  // Museums & galleries
  if (
    normalized === "museum" ||
    normalized === "gallery" ||
    normalized === "arts centre" ||
    normalized === "library"
  ) {
    return "Museums & galleries";
  }

  // Parks & views
  if (
    normalized === "park" ||
    normalized === "garden" ||
    normalized === "viewpoint" ||
    normalized === "golf course" ||
    normalized === "outdoors" ||
    normalized === "beach" ||
    normalized === "hill"
  ) {
    return "Parks & views";
  }

  // Historic sites
  if (
    normalized === "historic site" ||
    normalized === "church" ||
    normalized === "cemetery" ||
    normalized === "castle" ||
    normalized === "monument"
  ) {
    return "Historic sites";
  }

  // Arts & music
  if (
    normalized === "arts" ||
    normalized === "music" ||
    normalized === "cinema" ||
    normalized === "comedy" ||
    normalized === "festival"
  ) {
    return "Arts & music";
  }

  // Markets
  if (normalized === "market" || normalized === "food") {
    return "Markets";
  }

  return "Other";
}

/** Order buckets should appear in the filter UI. */
const BUCKET_ORDER = [
  "Tours & walks",
  "Museums & galleries",
  "Parks & views",
  "Historic sites",
  "Arts & music",
  "Markets",
  "Other",
];

/** Distinct type buckets actually present in a list, in bucket-order. */
export function distinctTypeBuckets(items: FreeAnyTimeItem[]): string[] {
  const buckets = new Set<string>();
  for (const item of items) {
    buckets.add(typeToTypeBucket(item.typeLabel));
  }
  return BUCKET_ORDER.filter((b) => buckets.has(b));
}

/** Distinct, non-null `district` values actually present in a
 *  list, in first-seen order — the page only ever offers a filter chip for a
 *  value that has at least one matching item. */
export function distinctDistricts(items: FreeAnyTimeItem[]): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of items) {
    const value = item.district;
    if (value && !seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }
  return values.sort((a, b) => a.localeCompare(b));
}

/** Legacy: distinct type labels for backward compatibility. Deprecated — use distinctTypeBuckets instead. */
export function distinctValues(items: FreeAnyTimeItem[], pick: (item: FreeAnyTimeItem) => string | null): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of items) {
    const value = pick(item);
    if (value && !seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }
  return values.sort((a, b) => a.localeCompare(b));
}

export function matchesFreeAnyTimeFilters(
  item: FreeAnyTimeItem,
  typeBucket: string | null,
  district: string | null
): boolean {
  if (typeBucket != null && typeToTypeBucket(item.typeLabel) !== typeBucket) return false;
  if (district != null && item.district !== district) return false;
  return true;
}
