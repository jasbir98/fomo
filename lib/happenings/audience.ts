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

import type { HappeningEligibility } from "@/lib/happenings/types";
import { whoGroupForEligibility, type DealWhoGroup } from "@/lib/happenings/groups";

export type NicheAudience = "accessibility" | "older" | "youth" | "parents" | "professional" | "course" | "support";

/** Checked in order; first match wins. Title patterns are broader than description ones. */
const RULES: { audience: NicheAudience; title: RegExp; description?: RegExp }[] = [
  {
    audience: "accessibility",
    title: /\bdementia[- ]friendly\b|\bdementia (?:cafe|café|group|choir|session|support)\b|\brelaxed performance\b|\bfor carers\b|\bcarers?['’]? (?:group|cafe|café|session)\b/i,
    description: /\bdementia[- ]friendly\b/i,
  },
  {
    audience: "older",
    title: /\bover[- ]?(?:50|55|60|65)s?\b|\b(?:60|65)\+|\bseniors?\b|\bpensioners?\b|\bsilver (?:surfers|screen|club)\b|\bolder (?:people|adults)\b/i,
  },
  {
    // Entitlements for children and teenagers ("National Galleries Free Entry
    // for Under-18s"). Under-26 is NOT here: that is Fomo's own audience.
    audience: "youth",
    title: /\bunder[- ]?(?:18|16|15|14|12|11|10|8|5)s?\b|\bjuniors? (?:tickets?|rates?|entry|prices?)\b|\bteen(?:s|age|agers)? (?:nights?|clubs?|sessions?|groups?)\b/i,
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

/** A listing for a niche audience sits this far below the main crowd's picks. */
export const NICHE_AUDIENCE_PENALTY = 20;

/**
 * The niche-audience markdown for a visitor in groups `who`: an "older"
 * listing isn't niche for an over-60, a "parents" or "youth" one isn't for a
 * visitor who said they have a family. Zero for a listing for anyone.
 */
export function nicheAudiencePenalty(title: string, description: string | null | undefined, who: readonly DealWhoGroup[]): number {
  const audience = nicheAudience(title, description);
  if (!audience) return 0;
  if (audience === "older" && who.includes("over_60")) return 0;
  if ((audience === "parents" || audience === "youth") && who.includes("families")) return 0;
  return NICHE_AUDIENCE_PENALTY;
}

/* -------------------------------------------------------------------------
 * Lead-slot persona fit
 *
 * The slots a visitor sees first (Home hero, Today's deals, Top picks, the top
 * of /deals) are for students and young professionals who want something cheap
 * to do. These rules mark down, never hide, listings that are real but not
 * that: a hotel stay, a haircut, a corporate package, an admission discount at
 * a tourist attraction, an offer for an audience the visitor isn't known to be
 * in, and adult-themed listings. Every adjustment lives here, next to the
 * niche-audience rules above, so the numbers can be tuned in one place.
 * Everything stays in "See all" and the filters.
 * ----------------------------------------------------------------------- */

export type LeadMisfit = "sensitive" | "accommodation" | "beauty" | "corporate" | "attraction";

/** Score points taken off per misfit. No visitor pref opts out of these: nobody sets "I want a hotel stay". */
export const LEAD_MISFIT_PENALTY: Record<LeadMisfit, number> = {
  /** Adult-themed (fetish, kink, strip, erotic). Big enough to drop out of the hero and any top five. */
  sensitive: 60,
  /** Hotel stays and overnight packages: not a night out, and rarely cheap. */
  accommodation: 30,
  /** Hairdressers, salons, nails, spa treatments. */
  beauty: 30,
  /** Corporate, team-building and function-room packages. */
  corporate: 25,
  /** Admission discount at a paid tourist attraction. Free attractions are untouched. */
  attraction: 20,
};

/** Penalty, in the deals lists, for an offer restricted to a group the visitor isn't known to be in (EH residents, over 60, family). Under-18s and the like go through the "youth" niche audience. */
export const NARROW_ELIGIBILITY_DEAL_PENALTY = 15;

/** Eligibility groups outside the core audience. Student and under-26 offers are what Fomo is for, so they are never marked down. */
const OFF_AUDIENCE_GROUPS: ReadonlySet<DealWhoGroup> = new Set<DealWhoGroup>(["residents", "over_60", "families"]);

const SENSITIVE =
  // No age gates ("18+" is every club night) and no words that are also titles
  // (the Kinks, Kinky Boots, the film Swingers, XXX).
  /\bfetish\b|\bkink\b|\bbdsm\b|\bstrip(?:per|pers|tease)\b|\berotic\w*\b|\bsex (?:party|club|work|toys?)\b|\badults? only\b/i;

const ACCOMMODATION_PLACE = /\b(?:hotel|b&b|bed (?:and|&) breakfast|accommodation|apartments?|aparthotel|guest ?house|hostel|lodges?|resort)\b/i;
// "night" and "room" are NOT stay words: a hostel hosting a quiz night, a hotel's escape room.
const ACCOMMODATION_STAY = /\b(?:stay|suite|package)\b/i;
const ACCOMMODATION_ALONE =
  /\bovernight\b|\bnight'?s? stay\b|\bhotel stay\b|\b(?:\d+|one|two|three)[- ]nights?\b(?=.*\b(?:stay|hotel|b&b|accommodation|package|breakfast)\b)/i;

const BEAUTY =
  // Treatment or business words only: bare "beauty", "salon", "nails", "lash", "brow",
  // "waxing" and "barbers" are also show titles ("Sleeping Beauty", "Literary Salon").
  /\bhair(?:cuts?|dress\w*|care)\b|\bhair (?:salon|studio|colour|treatment)s?\b|\b(?:beauty|nail|nails) (?:salon|treatments?|bar|therapist|studio|tech)s?\b|\bsalon (?:appointment|treatment)s?\b|\bbarbershops?\b|\bbarbering\b|\bmanicure\b|\bpedicure\b|\bfacials?\b|\bmassages?\b|\bspa (?:day|treatment|package|access|entry)s?\b|\bspa\b(?=.*\b(?:treatment|massage|facial)s?\b)|\beyelash(?:es)?\b|\blash (?:lift|extensions?|tint)s?\b|\beyebrow\b|\bbrow (?:lamination|tint|bar|wax)\b|\b(?:leg|bikini|brazilian) wax(?:ing)?\b|\bwaxing (?:salon|treatment|studio)s?\b|\bblow[- ]?dry\b|\bbalayage\b|\bcheynes\b|\bcharlie miller\b|\btoni ?(?:&|and) ?guy\b|\bsupercuts\b|\bsassoon\b/i;

const CORPORATE =
  /\bcorporate\b|\bteam[- ]?building\b|\bfunction rooms?\b|\bmeeting rooms?\b|\bprivate hire\b|\bvenue hire\b|\bconference packages?\b|\bhospitality packages?\b|\bparty packages?\b/i;

/** Paid tourist attractions. Matched as whole words on the venue, or the title when there's no venue. */
const TOURIST_ATTRACTIONS = [
  "scotch whisky experience",
  "royal yacht britannia",
  "camera obscura",
  "edinburgh dungeon",
  "edinburgh castle",
  "mary king's close",
  "the edinburgh vaults",
  "city sightseeing",
  "hop on hop off",
  "open top bus",
  "majestic tour",
  "dynamic earth",
  "deep sea world",
  "edinburgh bus tours",
  "palace of holyroodhouse",
];
const ATTRACTION = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:${TOURIST_ATTRACTIONS.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:$|[^\\p{L}\\p{N}])`,
  "iu"
);

export interface LeadFitInput {
  title: string;
  description?: string | null;
  venue_name?: string | null;
  saving_label?: string | null;
  is_free?: boolean | null;
  /** Student and under-26 offers are exempt from the attraction misfit: £1 entry for under-26s is the steal this audience wants. */
  eligibility?: HappeningEligibility | null;
}

/** The lead-slot misfit of a listing, or null when it suits the main crowd. The most penalised one wins; they never add up. */
export function leadMisfit(h: LeadFitInput): LeadMisfit | null {
  const title = h.title ?? "";
  const venue = (h.venue_name ?? "").replace(/[‘’]/g, "'");
  const front = `${title} ${h.saving_label ?? ""}`;
  if (SENSITIVE.test(title) || SENSITIVE.test(h.description ?? "")) return "sensitive";
  if (ACCOMMODATION_ALONE.test(front) || ((ACCOMMODATION_PLACE.test(title) || ACCOMMODATION_PLACE.test(venue)) && ACCOMMODATION_STAY.test(front))) {
    return "accommodation";
  }
  if (BEAUTY.test(title) || BEAUTY.test(venue)) return "beauty";
  if (CORPORATE.test(front)) return "corporate";
  const coreAudience = h.eligibility === "student" || h.eligibility === "under_26";
  if (!h.is_free && !coreAudience && ATTRACTION.test((venue || title).replace(/[‘’]/g, "'"))) return "attraction";
  return null;
}

/** Points to take off a listing's lead-slot score for `leadMisfit`. 0 when it fits. */
export function leadMisfitPenalty(h: LeadFitInput): number {
  const misfit = leadMisfit(h);
  return misfit ? LEAD_MISFIT_PENALTY[misfit] : 0;
}

/**
 * Every lead-slot adjustment for a DEAL, for the deals lists (Today's deals,
 * /deals): the misfit above, a niche audience (over 60s, under-18s...), or an
 * offer for an eligibility group the visitor isn't in. `who` is their stored
 * profile: a resident, an over-60 or a parent gets no penalty for their own
 * group. The largest single adjustment applies; they don't stack.
 */
export function dealLeadPenalty(h: LeadFitInput & { eligibility: HappeningEligibility }, who: readonly DealWhoGroup[]): number {
  const group = whoGroupForEligibility(h.eligibility);
  const eligibility = group && OFF_AUDIENCE_GROUPS.has(group) && !who.includes(group) ? NARROW_ELIGIBILITY_DEAL_PENALTY : 0;
  return Math.max(leadMisfitPenalty(h), nicheAudiencePenalty(h.title, h.description, who), eligibility);
}
