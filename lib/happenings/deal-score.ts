/**
 * Fomo Happenings — how good a deal is, for ordering deal lists.
 *
 * Deal lists used to keep their input order (curator `priority`, then
 * `saving_amount`, which is sometimes a saving and sometimes a price), so
 * "10% off COSMO for students" or a chain's every-day student discount could
 * lead Home's "Today's deals" over a 2-for-1 that only runs on Tuesdays.
 * `dealStealScore` puts the steals first: deep discounts, offers tied to a
 * day or two of the week, local places over national chains, and the
 * curator's own priority. It only orders; nothing is hidden.
 *
 * Pure, no `server-only`: runs on the server (/api/feed's deals section)
 * and the client (lib/happenings/today-deals.ts).
 */
import { normalizeRecurrence } from "@/lib/happenings/occurrence";
import type { Happening } from "@/lib/happenings/types";
import { dealLeadPenalty } from "@/lib/happenings/audience";
import type { DealWhoGroup } from "@/lib/happenings/groups";

/**
 * National chains and UK-wide schemes. Their student discounts are real but
 * everyone already knows them, and they're the same in every city, so they
 * shouldn't lead an Edinburgh list. Matched as whole words on the venue
 * name, or on the title when there's no venue.
 */
const NATIONAL_CHAINS = [
  "all bar one",
  "ask italian",
  "bella italia",
  "boom battle bar",
  "brewdog",
  "browns",
  "burger king",
  "byron",
  "caffe nero",
  "caffè nero",
  "cineworld",
  "cosmo",
  "costa",
  "côte",
  "dishoom",
  "domino's",
  "escape hunt",
  "everyman",
  "five guys",
  "frankie & benny's",
  "gourmet burger kitchen",
  "greggs",
  "harvester",
  "hotel du vin",
  "hotel indigo",
  "ibis",
  "itsu",
  "kfc",
  "las iguanas",
  "leon",
  "mcdonald's",
  "miller & carter",
  "nando's",
  "nuffield health",
  "o'neill's",
  "odeon",
  "pho",
  "pizza express",
  "pizza hut",
  "pizzaexpress",
  "premier inn",
  "pret",
  "prezzo",
  "puregym",
  "revolution",
  "slug & lettuce",
  "slug and lettuce",
  "starbucks",
  "subway",
  "superdrug",
  "tgi fridays",
  "the body shop",
  "the gym group",
  "tiger tiger",
  "toby carvery",
  "travelodge",
  "turtle bay",
  "vue",
  "wagamama",
  "wahaca",
  "wetherspoon",
  "yo! sushi",
  "zizzi",
  // UK-wide travel cards: useful, not a find.
  "railcard",
  "ridacard",
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word match. `\b` fails next to "!" or "'", so the edges are spelled out.
const CHAIN_PATTERN = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${NATIONAL_CHAINS.map(escapeRegExp).join("|")})(?:$|[^\\p{L}\\p{N}])`, "iu");

/** True for a national chain or UK-wide scheme (see `NATIONAL_CHAINS`). */
export function isNationalChain(h: Pick<Happening, "title" | "venue_name">): boolean {
  const name = (h.venue_name ?? "").trim() || h.title;
  // Curly apostrophes ("O’Neill’s") count the same as straight ones.
  return CHAIN_PATTERN.test(name.replace(/[‘’]/g, "'"));
}

/**
 * Rough discount depth as a percentage, 0–90, read from `saving_label` (and
 * the title). A label that names no percentage is mapped to one: 2-for-1 is
 * 50, a freebie 40, a ticket at £6 or less 40, "£N off" 20 (no base price
 * to compare against). Unknown is 10.
 */
export function dealDepth(h: Pick<Happening, "title" | "saving_label">): number {
  const text = `${h.saving_label ?? ""} ${h.title}`;
  const percents = Array.from(text.matchAll(/(\d{1,2})\s*%/g), (m) => Number(m[1]));
  if (percents.length > 0) return Math.min(Math.max(...percents), 90);
  if (/\b1\/3\s*off\b/i.test(text)) return 33;
  if (/\b2[\s-]?for[\s-]?1\b|\bhalf[\s-]?price\b|\bbogof\b/i.test(text)) return 50;
  if (/\b(free|complimentary)\b/i.test(text)) return 40;
  if (/£\s*\d+(?:\.\d+)?\s*off\b/i.test(text)) return 20;
  const price = text.match(/£\s*(\d+(?:\.\d+)?)/);
  if (price) {
    const pounds = Number(price[1]);
    if (pounds <= 6) return 40;
    if (pounds <= 15) return 20;
  }
  return 10;
}

/** Points for a weekly offer that runs on only a few days ("2-for-1 Tuesdays"), keyed by days per week. */
function dayRarity(days: number): number {
  if (days <= 2) return 20;
  if (days <= 4) return 8;
  return 0;
}

const CHAIN_PENALTY = 25;

/**
 * Higher is a better deal. Depth is worth up to 30, a deal tied to one or
 * two weekdays 20, the curator's priority ±15, and a national chain −25, so a
 * chain needs a much deeper discount than a local place to rank above it.
 */
export function dealStealScore(
  h: Pick<Happening, "title" | "venue_name" | "saving_label" | "priority" | "recurrence">
): number {
  let score = Math.round(dealDepth(h) * 0.6);
  const rec = normalizeRecurrence(h.recurrence);
  if (rec.type === "weekly") score += dayRarity(rec.days.length);
  score += Math.min(Math.max((h.priority ?? 50) - 50, -15), 15);
  if (isNationalChain(h)) score -= CHAIN_PENALTY;
  return score;
}

/**
 * `dealStealScore` with the lead-slot persona fit taken off (audience.ts
 * `dealLeadPenalty`): a hotel stay, a haircut, a tourist-attraction ticket or
 * an offer for a group the visitor isn't in sinks below the steals a student
 * would actually use. `who` is the visitor's stored deals profile; a match
 * removes the audience penalty. Used to ORDER lists only, never to hide: the
 * "good deal" floor (`GOOD_FLOOR` in today-deals.ts) still reads the plain
 * steal score, so a penalised deal stays in "See all" and the filters.
 */
export function dealLeadScore(
  h: Pick<Happening, "title" | "summary" | "venue_name" | "saving_label" | "priority" | "recurrence" | "is_free" | "eligibility">,
  who: readonly DealWhoGroup[] = []
): number {
  return dealStealScore(h) - dealLeadPenalty({ ...h, description: h.summary }, who);
}
