"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { CITY } from "@/lib/city";
import { useSignedIn } from "@/lib/useSaved";
import type { WeatherCondition } from "@/lib/weather";
import { WEATHER_THEME } from "@/lib/weatherUi";
import { FomoLogo, Icon } from "@/components/ui";
import { InstallSheet } from "@/components/install/InstallSheet";
import { useInstallState } from "@/lib/pwa/useInstallState";

export interface HeaderWeather {
  condition: WeatherCondition;
  tempC: number | null;
}

// Module-scope, not per-mount state: every page that renders AppHeader
// wants the same "today in Edinburgh" forecast, so the first mount's request is shared
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
  /** Extra content beside the logo, e.g. Home's city picker pill. */
  leading?: ReactNode;
  /**
   * Weather the page already has (Home fetches its own for the ambient
   * backdrop). Pass it to skip this header's own /api/weather request; `null`
   * means "loading or unavailable". Leave undefined to let the header fetch.
   */
  weather?: HeaderWeather | null;
  className?: string;
}

/**
 * Shared top app bar used by every tab: Fomo wordmark, weather chip, Search
 * link, "Get the app" chip (phones, until installed), Profile/Sign in.
 * Home passes its city picker pill through `leading`; other tabs skip it (it's
 * noise there, and with SUPPORTED_CITIES.length === 1 it never renders anyway,
 * see lib/city.ts).
 */
export function AppHeader({ title, leading, weather: weatherProp, className = "" }: AppHeaderProps) {
  const [fetchedWeather, setFetchedWeather] = useState<HeaderWeather | null>(null);
  const weather = weatherProp !== undefined ? weatherProp : fetchedWeather;
  const signedIn = useSignedIn();
  const { platform, installed } = useInstallState();
  const [installOpen, setInstallOpen] = useState(false);
  // Phones and tablets only, and only until the app is installed.
  const showInstallChip = platform !== null && platform !== "desktop" && !installed;

  useEffect(() => {
    if (weatherProp !== undefined) return;
    let cancelled = false;
    void fetchWeatherOnce().then((w) => {
      if (!cancelled) setFetchedWeather(w);
    });
    return () => {
      cancelled = true;
    };
  }, [weatherProp]);

  return (
    <div
      className={`sticky top-0 z-40 flex flex-col border-b border-hairline bg-surface-container-lowest/95 backdrop-blur-xl ${className}`}
    >
      <header className="flex min-h-[64px] items-center justify-between gap-2 px-4 pt-safe">
        <div className="flex min-w-0 items-center gap-2.5">
          <FomoLogo size={28} />
          {leading}
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
              {weather?.tempC != null ? `${Math.round(weather.tempC)}°` : "–°"}
            </span>
          </div>
          <Link
            href="/search"
            aria-label="Search"
            className="flex h-11 w-11 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
          >
            <Icon name="search" size={24} />
          </Link>
          {showInstallChip ? (
            // Icon-only until there's room for the words; gone below 360px
            // (the Sign in pill is the wide neighbour it competes with).
            <button
              type="button"
              onClick={() => setInstallOpen(true)}
              aria-label="Get the app"
              className="flex h-10 items-center justify-center gap-1 rounded-full bg-primary-container/10 px-2.5 text-label-sm font-semibold text-primary transition-colors hover:bg-primary-container/20 max-[359px]:hidden"
            >
              <Icon name="install_mobile" size={18} />
              <span className="hidden min-[420px]:inline">Get the app</span>
            </button>
          ) : null}
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
        <div className="px-4 pb-3">
          <h1 className="truncate text-headline-sm text-primary">{title}</h1>
        </div>
      ) : null}

      <InstallSheet open={installOpen} onClose={() => setInstallOpen(false)} source="header" />
    </div>
  );
}

export default AppHeader;
