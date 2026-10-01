/**
 * Fomo Happenings — title/subtitle text for the compact deal cards (Home's
 * "Today's deals" strip and the grouped venue cards on /deals).
 *
 * Rule: the TITLE is the venue's short name and the SUBTITLE is the offer in
 * plain words ("30% off food · Students"), built from the deal's own fields.
 * The two must never echo each other — the old cards printed the venue as
 * the title and a truncated deal title ("ASK Italian 30% Off Foo...") as
 * the subtitle, which read as the same text twice.
 *
 * Pure and dependency-light (no fetch, no DOM) so it unit-tests with
 * `npx tsx --test`.
 */
import { ELIGIBILITY_FALLBACK, savingBadgeLabel } from "@/lib/happenings/format";
import { WHO_GROUP_LABEL, whoGroupForEligibility } from "@/lib/happenings/groups";
import type { Happening } from "@/lib/happenings/types";

export type DealLabelFields = Pick<
  Happening,
  "title" | "venue_name" | "saving_label" | "saving_amount" | "currency" | "is_free" | "eligibility"
>;

/** A cleaned label longer than this is too wordy for a one-line subtitle, so the short badge form is preferred when one exists. */
const MAX_LABEL_CHARS = 28;

function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

function wordKey(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9%£]/g, "");
}

/**
 * Drops the venue name from the start of `text` ("ASK Italian 30% Off Food"
 * at venue "ASK Italian Edinburgh" -> "30% Off Food"). Compares word by word
 * and strips the longest leading run shared with the venue name; never
 * strips the whole string (a title that IS the venue stays as is).
 */
export function stripVenuePrefix(text: string, venue: string | null | undefined): string {
  const trimmed = text.trim();
  if (!venue) return trimmed;
  const tw = words(trimmed);
  const vw = words(venue);
  let run = 0;
  while (run < tw.length && run < vw.length && wordKey(tw[run]) !== "" && wordKey(tw[run]) === wordKey(vw[run])) run++;
  if (run === 0 || run >= tw.length) return trimmed;
  return tw.slice(run).join(" ").replace(/^[\s:·,\-–]+/, "").trim();
}

/** "Off" -> "off", "Food" -> "food": lowercases everything but an initial capital and ALL-CAPS tokens ("EH"). */
function sentenceCase(s: string): string {
  const ws = words(s).map((w) => (/^[A-Z]{2,}$/.test(w.replace(/[^A-Za-z]/g, "")) && /[A-Z]{2,}/.test(w) ? w : w.toLowerCase()));
  const out = ws.join(" ");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function tidyMoney(s: string): string {
  return s.replace(/£(\d+)\.00\b/g, "£$1");
}

/**
 * The offer in plain words, WITHOUT the "who it's for" suffix and without
 * the venue name — or null when the deal carries nothing offer-like.
 * Source order: the (cleaned) `saving_label`; the short badge form when the
 * label is long or odd ("saving you over £200 compared to paying at the
 * gate" -> "£200 off"); the deal title minus its venue prefix.
 */
export function dealOfferCore(h: DealLabelFields): string | null {
  const venue = h.venue_name;
  let label = stripVenuePrefix(h.saving_label ?? "", venue).replace(/\s+/g, " ").trim();
  const badge = savingBadgeLabel(h);

  if (label) {
    // "Save up to 57%" / "Save 51%" -> "Up to 57% off" / "51% off"
    const save = label.match(/^save\s+(up to\s+)?(\d+%|£\s?\d+(?:\.\d+)?)\s*$/i);
    if (save) label = `${save[1] ? "Up to " : ""}${save[2].replace(/\s/g, "")} off`;
    // "20% discount on your first lesson" / "10% Student Discount" -> "20% off your first lesson" / "10% off"
    label = label.replace(/(\d+%|£\s?\d+(?:\.\d+)?)\s+(?:student |resident |local )?discount(?:\s+on)?/i, "$1 off");
    // Bare "20%" -> "20% off"
    if (/^\d+%$/.test(label)) label = `${label} off`;
    label = tidyMoney(label);

    if (label.length > MAX_LABEL_CHARS && badge) return badge;
    if (label.length > MAX_LABEL_CHARS * 2) label = "";
  }
  if (label) return sentenceCase(label);

  if (badge) return badge;

  // No saving data at all: say what the deal is, minus the venue echo.
  // Without a venue the card's title IS the deal title (or its "at <venue>"
  // tail), so echoing it as the subtitle would repeat the same words.
  const fromTitle = stripVenuePrefix(h.title, venue);
  if (!venue || !fromTitle || fromTitle === venue || fromTitle === h.title.trim()) return null;
  return fromTitle;
}

/** "EH residents" / "Students" / "Members" — null for an unrestricted deal. */
export function dealWhoLabel(eligibility: Happening["eligibility"]): string | null {
  const group = whoGroupForEligibility(eligibility);
  if (group) return WHO_GROUP_LABEL[group];
  return ELIGIBILITY_FALLBACK[eligibility] ?? null;
}

function appendWho(core: string, who: string | null): string {
  if (!who) return core;
  // "10% student discount" already says who it's for.
  const lower = core.toLowerCase();
  if (/student/.test(lower) && /student/i.test(who)) return core;
  if (/resident/.test(lower) && /resident/i.test(who)) return core;
  return `${core} · ${who}`;
}

/** Card title: the venue's short name, else the deal's own title. */
export function dealCardTitle(h: Pick<Happening, "title" | "venue_name">, fallbackVenue?: string | null): string {
  const named = h.venue_name?.trim() || fallbackVenue?.trim();
  if (named) return named;
  // "EH Residents 20% off at 1802 Lounge & Grill" -> "1802 Lounge & Grill"
  const at = h.title.match(/\sat\s+(.{3,})$/i);
  return at ? at[1].trim() : h.title;
}

/**
 * Subtitle for a single-deal card: "30% off food · Students",
 * "20% off · EH residents", "2-for-1". Null only when the deal has nothing
 * to say beyond its venue (the card then shows no second line).
 */
export function dealSubtitle(h: DealLabelFields): string | null {
  const core = dealOfferCore(h);
  const who = dealWhoLabel(h.eligibility);
  if (!core) return who;
  return appendWho(core, who);
}

function percentOf(text: string | null): number {
  const m = text?.match(/(\d+)\s*%/);
  return m ? Number(m[1]) : 0;
}

/**
 * Subtitle for a combined venue card (badge already says "N deals"): the
 * best offer, "Up to 30% off" when the offers differ. Never repeats the
 * badge text. The who suffix is kept only when every offer shares the same
 * restriction.
 */
export function dealGroupSubtitle(offers: DealLabelFields[]): string | null {
  if (offers.length === 0) return null;
  const scored = offers.map((h) => {
    const core = dealOfferCore(h);
    return { h, core, pct: percentOf(core) || percentOf(savingBadgeLabel(h)) };
  });
  const bestPct = scored.reduce((b, s) => (s.pct > b.pct ? s : b), scored[0]);
  const withAmount = scored.filter((s) => s.h.saving_amount != null);
  const best =
    bestPct.pct > 0
      ? bestPct
      : withAmount.length > 0
        ? withAmount.reduce((b, s) => ((s.h.saving_amount ?? 0) > (b.h.saving_amount ?? 0) ? s : b))
        : (scored.find((s) => s.core) ?? scored[0]);

  let core = best.core;
  if (core && best.pct > 0 && !/^up to /i.test(core)) {
    // Several different deals: headline the best percentage as a ceiling.
    const differ = new Set(scored.map((s) => s.core ?? "")).size > 1;
    if (differ) core = `Up to ${best.pct}% off`;
  }

  const whos = new Set(offers.map((h) => dealWhoLabel(h.eligibility)));
  const sharedWho = whos.size === 1 ? [...whos][0] : null;
  if (!core) return sharedWho;
  return appendWho(core, sharedWho);
}
