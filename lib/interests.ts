/**
 * Single source of truth for the fixed set of trip interests offered in the
 * Travel DNA form (`app/setup/travel-dna/page.tsx`) and rendered read-only
 * on the Profile page (`app/(shell)/profile/page.tsx`). Keeping both in one
 * place means adding an interest automatically gets it a matching icon
 * everywhere, with no risk of the two views drifting apart.
 */
export const INTERESTS = [
  { label: "History", icon: "history_edu" },
  { label: "Museums", icon: "museum" },
  { label: "Art", icon: "palette" },
  { label: "Architecture", icon: "location_city" },
  { label: "Food & Dining", icon: "restaurant" },
  { label: "Nightlife", icon: "nightlife" },
  { label: "Shopping", icon: "shopping_bag" },
  { label: "Nature & Outdoors", icon: "forest" },
  { label: "Hiking", icon: "hiking" },
  { label: "Beach", icon: "beach_access" },
  { label: "Wellness & Spa", icon: "spa" },
  { label: "Music", icon: "music_note" },
  { label: "Photography", icon: "photo_camera" },
  { label: "Anime & Pop Culture", icon: "animation" },
  { label: "Adventure Sports", icon: "sports_martial_arts" },
  { label: "Local Culture", icon: "groups" },
  { label: "Wildlife", icon: "pets" },
  { label: "Festivals & Events", icon: "celebration" },
] as const;

const INTEREST_ICONS: Record<string, string> = Object.fromEntries(
  INTERESTS.map((opt) => [opt.label, opt.icon])
);

/** Icon for a saved interest label; falls back to a generic marker for anything not in the fixed set (e.g. legacy data). */
export function interestIcon(label: string): string {
  return INTEREST_ICONS[label] ?? "interests";
}
