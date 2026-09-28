import type { CardSubjectType } from "@/lib/types";

/**
 * Shared card-shape types — split out of the old lib/now/types.ts (the
 * /api/now ranker, removed in the 2026-09 Fomo cleanup) because Saved, the
 * Home feed and FomoCard all still render this same shape and needed
 * somewhere to import it from that isn't the deleted ranker module.
 */

export type CardKind = "add" | "directions" | "swap" | "book" | "tell" | "location" | "watch";

export interface CardAction {
  label: string;
  kind: CardKind;
}

export type Urgency = "low" | "medium" | "high";

export interface CardImage {
  url: string | null;
  quality: "ok" | "thin" | "none";
}

/** One ranked/saved recommendation, rendered by FomoCard (components/fomo/Card.tsx). */
export interface Candidate {
  generator: string;
  baseScore: number;
  score: number;
  subject: { type: CardSubjectType; id: string };
  pill: string;
  why: string;
  headline: string;
  detail: string;
  primaryAction: CardAction;
  image: CardImage;
  urgency: Urgency;
  validFrom: string;
  validUntil: string;
  distanceKm: number | null;
  /** Raw subject name (place/event title) — distinct from `headline`, which can carry extra framing ("X, now or not today"). Used by the card's Directions/Save/Ask Fomo actions, which need the plain name, not the copy. */
  subjectName: string;
  /** Lat/lng for the Directions action, when the subject has coordinates. */
  coords: { lat: number; lng: number } | null;
  railTitle: string;
  railMeta: string;
}
