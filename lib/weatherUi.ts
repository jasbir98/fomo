/**
 * Client-safe weather display theming — background/icon treatment per
 * condition, shared by the disruption screen and Home's weather chip.
 *
 * Only imports `WeatherCondition` as a type (erased at compile time), so
 * this module carries none of `lib/weather.ts`'s `server-only` restriction
 * and can be imported from "use client" components.
 */
import type { WeatherCondition } from "@/lib/weather";

export interface WeatherTheme {
  /** Material Symbols Outlined ligature name. */
  icon: string;
  label: string;
  /** Full-bleed themed background for the disruption screen. */
  bannerClass: string;
  iconClass: string;
  /** Compact pill background+text for Home's weather chip. */
  chipClass: string;
}

// Simple background/icon treatment per condition — a color per state plus a
// matching Material Symbols icon, built from `app/globals.css`'s existing
// `@theme` color tokens (no new tokens invented). Deliberately no weather
// animation — just enough to make each state visually distinct.
export const WEATHER_THEME: Record<WeatherCondition, WeatherTheme> = {
  sunny: {
    icon: "sunny",
    label: "Sunny",
    bannerClass:
      "bg-gradient-to-b from-secondary-container/20 via-surface to-surface",
    iconClass: "text-secondary",
    chipClass: "bg-secondary-container/15 text-on-secondary-container",
  },
  cloudy: {
    icon: "cloud",
    label: "Cloudy",
    bannerClass:
      "bg-gradient-to-b from-surface-container-high via-surface to-surface",
    iconClass: "text-on-surface-variant",
    chipClass: "bg-surface-container text-on-surface-variant",
  },
  rainy: {
    icon: "rainy",
    label: "Rainy",
    bannerClass:
      "bg-gradient-to-b from-error-container/60 via-surface to-surface",
    iconClass: "text-error",
    chipClass: "bg-error-container/50 text-on-error-container",
  },
  windy: {
    icon: "air",
    label: "Windy",
    bannerClass:
      "bg-gradient-to-b from-tertiary-fixed/50 via-surface to-surface",
    iconClass: "text-tertiary",
    chipClass: "bg-tertiary-fixed/40 text-on-tertiary-fixed-variant",
  },
};
