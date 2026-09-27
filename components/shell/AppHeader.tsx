"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { CITY } from "@/lib/city";
import { useSignedIn } from "@/lib/useSaved";
import type { WeatherCondition } from "@/lib/weather";
import { WEATHER_THEME } from "@/lib/weatherUi";
import { FomoLogo, Icon } from "@/components/ui";

interface HeaderWeather {
  condition: WeatherCondition;
  tempC: number | null;
}

// Module-scope, not per-mount state: every page that renders AppHeader (and
// Home's own header, once it's swapped over — see the task brief) wants the
// same "today in Edinburgh" forecast, so the first mount's request is shared
// rather than every mount in one page load firing its own /api/weather call.
// Reset to null on failure so a later mount (or a retry) gets a fresh chance
// rather than being stuck replaying a rejected promise forever.
let weatherPromise: Promise<HeaderWeather | null> | null = null;

function fetchWeatherOnce(): Promise<HeaderWeather | null> {
  if (!weatherPromise) {
    weatherPromise = fetch(`/api/weather?destination=${encodeURIComponent(CITY.name)}`)
      .then((res) => res.json())
      .then((json: { day?: { condition: WeatherCondition; tempMaxC: number | null } | null }) =>
        json.day ? { condition: json.day.condition, tempC: json.day.tempMaxC } : null
      )
      .catch((err) => {
        console.error("[AppHeader] weather fetch failed", err);
        weatherPromise = null;
        return null;
      });
  }
  return weatherPromise;
}

export interface AppHeaderProps {
  /** Rendered as a second row/h1 under the bar (e.g. "Explore Edinburgh"). Omit for a bare bar like Home's. */
  title?: ReactNode;
  className?: string;
}

/**
 * Shared top app bar: Fomo wordmark, weather chip, Saved link, Profile/Sign
 * in — reproduces Home's inline header (app/(shell)/page.tsx) as a drop-in
 * component so other tabs (Explore now; Home/Deals/Reels once they're
 * swapped over) render the identical bar instead of each hand-rolling it.
 * Deliberately excludes the city picker pill: Home keeps that itself (it's
 * meaningless noise on every other tab, and with SUPPORTED_CITIES.length
 * === 1 today it never renders there anyway — see lib/city.ts).
 */
export function AppHeader({ title, className = "" }: AppHeaderProps) {
  const [weather, setWeather] = useState<HeaderWeather | null>(null);
  const signedIn = useSignedIn();

  useEffect(() => {
    let cancelled = false;
    void fetchWeatherOnce().then((w) => {
      if (!cancelled) setWeather(w);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className={`sticky top-0 z-40 flex flex-col border-b border-hairline bg-surface-container-lowest/95 backdrop-blur-xl ${className}`}
    >
      <header className="flex min-h-[64px] items-center justify-between gap-2 px-4 pt-safe">
        <div className="flex min-w-0 items-center gap-2.5">
          <FomoLogo size={28} />
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* Neutral tint: the per-condition colours read as an alert (rain came out red). */}
          <div
            role="img"
            aria-label={
              weather && weather.tempC != null
                ? `${WEATHER_THEME[weather.condition].label}, ${Math.round(weather.tempC)} degrees`
                : "Weather unavailable"
            }
            className="flex items-center gap-1.5 rounded-full bg-surface-container px-2.5 py-1 text-on-surface-variant"
          >
            <Icon name={weather ? WEATHER_THEME[weather.condition].icon : "partly_cloudy_day"} size={16} />
            <span className="text-label-sm font-semibold">
              {weather?.tempC != null ? `${Math.round(weather.tempC)}°` : "—°"}
            </span>
          </div>
          <Link
            href="/saved"
            aria-label="Saved"
            className="flex h-10 w-10 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
          >
            <Icon name="bookmark" size={22} />
          </Link>
          {signedIn === null ? (
            // Auth state hasn't resolved yet — a neutral, non-interactive
            // placeholder (same footprint as the resolved states below)
            // instead of a Profile icon that would send a signed-out tap to
            // the account-gated /profile route a beat before we know better.
            <span
              aria-hidden="true"
              className="flex h-10 w-10 items-center justify-center"
            >
              <span className="h-8 w-8 animate-pulse rounded-full bg-surface-container" />
            </span>
          ) : signedIn === false ? (
            <Link
              href="/signin"
              className="ml-1 flex h-9 items-center rounded-full bg-primary px-3.5 text-label-md font-bold text-on-primary"
            >
              Sign in
            </Link>
          ) : (
            <Link href="/profile" aria-label="Profile" className="flex h-10 w-10 items-center justify-center">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-container text-on-primary">
                <Icon name="person" size={17} />
              </span>
            </Link>
          )}
        </div>
      </header>

      {title ? (
        <div className="px-5 pb-3">
          <h1 className="truncate text-headline-sm text-primary">{title}</h1>
        </div>
      ) : null}
    </div>
  );
}

export default AppHeader;
