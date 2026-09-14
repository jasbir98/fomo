"use client";

import { useEffect, useSyncExternalStore } from "react";
import { CITY, SUPPORTED_CITIES, findCityBySlug, type CityConfig } from "@/lib/city";
import { distanceKm, useGeolocation, type Coordinates } from "@/lib/geo";

/** localStorage key for an explicit city choice made in the picker. */
const CHOICE_KEY = "roameo:city:choice:v1";

interface PersistedChoice {
  /** `CityConfig.slug` of the explicitly-picked city, or null if never chosen. */
  slug: string | null;
  /** User closed the "confirm your city" prompt without picking -- stop asking. */
  dismissed: boolean;
}

const INITIAL_CHOICE: PersistedChoice = { slug: null, dismissed: false };

// Module-level shared store -- same rationale/pattern as lib/geo.ts: every
// route that reads the selected city (Home, Explore, Events, Experiences,
// Discover) shares ONE persisted choice instead of each re-reading
// localStorage, and the store starts at `INITIAL_CHOICE` on both server and
// the client's first render so hydration never mismatches -- localStorage is
// only read in an effect (`hydrate`, below), strictly after mount.
let choice: PersistedChoice = INITIAL_CHOICE;
const listeners = new Set<() => void>();
let hydrated = false;

function setChoice(next: PersistedChoice): void {
  choice = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): PersistedChoice {
  return choice;
}

function getServerSnapshot(): PersistedChoice {
  return INITIAL_CHOICE;
}

function persist(next: PersistedChoice): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHOICE_KEY, JSON.stringify(next));
  } catch {
    // Safari private mode / quota exceeded -- losing the persisted choice is fine, never crash for it.
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(CHOICE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<PersistedChoice>;
    setChoice({
      slug: typeof parsed.slug === "string" ? parsed.slug : null,
      dismissed: parsed.dismissed === true,
    });
  } catch {
    // Corrupt value -- ignore, stays at INITIAL_CHOICE.
  }
}

/** Explicit user pick from the city picker -- wins over geolocation, persists across reloads/navigation. */
export function chooseCity(city: CityConfig): void {
  const next: PersistedChoice = { slug: city.slug, dismissed: choice.dismissed };
  setChoice(next);
  persist(next);
}

/** User closed the "confirm your city" prompt without picking -- remember so it doesn't nag again. */
export function dismissCityPrompt(): void {
  if (choice.dismissed) return;
  const next: PersistedChoice = { ...choice, dismissed: true };
  setChoice(next);
  persist(next);
}

export type CitySource = "chosen" | "detected" | "default";

export interface SelectedCity {
  city: CityConfig;
  /** How `city` was resolved: an explicit pick, inferred from granted geolocation, or the un-confirmed fallback. */
  source: CitySource;
  /**
   * True once geolocation has resolved to denied/unsupported and the user
   * has neither picked a city nor dismissed the prompt before -- the signal
   * the UI uses to surface the picker once, without nagging on every load.
   */
  shouldPrompt: boolean;
}

/**
 * Nearest `SUPPORTED_CITIES` entry whose `nearRadiusKm` actually covers
 * `coords`, or null if none does (or there's no fix yet). Deliberately a
 * proximity check rather than "geolocation granted -> assume the fallback
 * city" -- a user in Tokyo who has granted location shouldn't have their
 * position reported as having "detected" Edinburgh; they just aren't near
 * any supported city, so this should return null and let the caller fall
 * back to `default`.
 */
function nearestSupportedCity(coords: Coordinates | null): CityConfig | null {
  if (!coords) return null;
  let nearest: CityConfig | null = null;
  let nearestKm = Infinity;
  for (const candidate of SUPPORTED_CITIES) {
    const km = distanceKm(coords, candidate.center);
    if (km <= candidate.nearRadiusKm && km < nearestKm) {
      nearest = candidate;
      nearestKm = km;
    }
  }
  return nearest;
}

/**
 * Resolution order: explicit choice (localStorage) -> granted geolocation
 * that's actually near a supported city -> Edinburgh fallback.
 * `SUPPORTED_CITIES` has exactly one entry today, so in practice `city`
 * either is Edinburgh (chosen, detected, or default) or -- once a second
 * city is added -- whichever one the user is nearest to. What this tracks
 * is *why* Fomo is showing that city, so callers can stop silently assuming
 * it and instead surface/confirm/remember that choice (see lib/city.ts's
 * `SUPPORTED_CITIES` doc comment for why the picker can't yet offer more).
 */
export function useSelectedCity(): SelectedCity {
  useEffect(() => {
    hydrate();
  }, []);

  const persisted = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { status: geoStatus, coords } = useGeolocation();

  const chosen = persisted.slug ? findCityBySlug(persisted.slug) : null;
  const detected = !chosen && geoStatus === "granted" ? nearestSupportedCity(coords) : null;
  const city = chosen ?? detected ?? CITY;
  const source: CitySource = chosen ? "chosen" : detected ? "detected" : "default";
  const shouldPrompt =
    !chosen && !persisted.dismissed && (geoStatus === "denied" || geoStatus === "unsupported");

  return { city, source, shouldPrompt };
}
