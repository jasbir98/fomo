/**
 * Niche audiences: listings that are real and worth keeping, but are for a
 * specific group rather than Fomo's main crowd (students and young
 * professionals looking for something to do). "Festival Theatre's Dementia
 * Friendly Activities" led the signed-out Top picks on 26 Oct because it is
 * free and on today; for most visitors it is noise.
 *
 * Ranking only: the hero scorers (lib/happenings/hero.ts) mark these down,
 * so they drop out of the top slots. Nothing is hidden; the full What's on
 * list still shows them in time order.
 *
 * Read from the title (and a few narrow description phrases) at display
 * time, so it applies to existing rows with no migration.
 */

export type NicheAudience = "accessibility" | "older" | "parents" | "professional" | "course" | "support";

/** Checked in order; first match wins. Title patterns are broader than description ones. */
const RULES: { audience: NicheAudience; title: RegExp; description?: RegExp }[] = [
  {
    audience: "accessibility",
    title: /\bdementia[- ]friendly\b|\bdementia (?:cafe|café|group|choir|session|support)\b|\brelaxed performance\b|\bfor carers\b|\bcarers?['’]? (?:group|cafe|café|session)\b/i,
    description: /\bdementia[- ]friendly\b/i,
  },
  {
    audience: "older",
    title: /\bover[- ]?(?:50|55|60|65)s?\b|\bseniors?\b|\bsilver (?:surfers|screen|club)\b|\bolder (?:people|adults)\b/i,
  },
  {
    // Antenatal and new-parent sessions. Kids' events themselves are
    // handled by family_fit (lib/happenings/family.ts), not here.
    audience: "parents",
    title: /\bpregnan\w*|\bantenatal\b|\bpostnatal\b|\bnew parents\b|\bparents?['\u2019]? (?:centre|group|talk|session)\b|\bbreastfeed\w*|\bparenting\b|\bmums? (?:and|&) (?:bumps|babies)\b/i,
  },
  {
    audience: "professional",
    title:
      /\bnetworking\b|\bconference\b|\bagm\b|\bannual general meeting\b|\bcpd\b|\bwebinar\b|\bleaders?(?:hip)? (?:meetup|meet-up|forum|breakfast|summit)\b|\bfor (?:founders|professionals|businesses|investors)\b|\bbusiness breakfast\b|\binvestor\b|\bexpo\b|\btrade (?:show|fair)\b|\bagri\w*\b/i,
  },
  {
    audience: "course",
    title:
      /\blanguage (?:class|classes|course|lessons?)\b|\b(?:irish|gaelic|spanish|french|german|italian|mandarin|japanese|arabic) (?:class|classes|course|lessons?)\b|\bfirst aid\b|\bcertificate\b|\baccredited\b|\btraining course\b|\b(?:\d+|one|two|three|four|five|six)[- ]week course\b|\bcourse\b.*\b(?:faw|efaw|cscs|sia)\b/i,
  },
  {
    audience: "support",
    title: /\bsupport group\b|\bbereavement\b|\bgrief (?:cafe|café|group|support)\b|\brecovery (?:group|meeting|cafe|café)\b|\b(?:alcoholics|narcotics|gamblers|overeaters|cocaine) anonymous\b|\bpeer support\b/i,
  },
];

/** The niche audience a listing is for, or null when it's for anyone. */
export function nicheAudience(title: string | null | undefined, description?: string | null): NicheAudience | null {
  const t = String(title ?? "");
  const d = String(description ?? "");
  for (const rule of RULES) {
    if (rule.title.test(t)) return rule.audience;
    if (rule.description && rule.description.test(d)) return rule.audience;
  }
  return null;
}
