"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CITY } from "@/lib/city";
import { useSignedIn } from "@/lib/useSaved";
import type { WeatherCondition } from "@/lib/weather";
import { WEATHER_THEME } from "@/lib/weatherUi";
import { FomoLogo, Icon } from "@/components/ui";
import { UserAvatar } from "./UserAvatar";
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
 * link, Saved bookmark (signed in only), "Get the app" chip (phones, until
 * installed), Profile/Sign in.
 * Home passes its city picker pill through `leading`; other tabs skip it (it's
 * noise there, and with SUPPORTED_CITIES.length === 1 it never renders anyway,
 * see lib/city.ts).
 *
 * From lg (1024px) up the side nav carries the logo, so the wordmark is
 * dropped here (`leading` stays), and the search icon is replaced by an inline
 * search field that submits to /search?q=. That field is tagged
 * `data-desktop-search` so the "/" shortcut (KeyboardShortcuts) can focus it.
 */
export function AppHeader({ title, leading, weather: weatherProp, className = "" }: AppHeaderProps) {
  const [fetchedWeather, setFetchedWeather] = useState<HeaderWeather | null>(null);
  const weather = weatherProp !== undefined ? weatherProp : fetchedWeather;
  const signedIn = useSignedIn();
  const router = useRouter();
  const [searchText, setSearchText] = useState("");
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

  function submitSearch(e: FormEvent) {
    e.preventDefault();
    const q = searchText.trim();
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  }

  return (
    <div
      className={`sticky top-0 z-40 flex flex-col border-b border-hairline bg-surface-container-lowest/95 backdrop-blur-xl ${className}`}
    >
      <header className="flex min-h-[64px] items-center justify-between gap-2 px-4 pt-safe lg:px-8">
        <div className="flex min-w-0 items-center gap-2.5">
          {/* A wrapper rather than a class on FomoLogo itself, which sets its own `inline-flex`. */}
          <div className="flex shrink-0 lg:hidden">
            <FomoLogo size={28} />
          </div>
          {leading}
        </div>

        {/* Desktop search: auto right margin keeps it beside the left cluster while the
            weather/profile cluster stays pinned right. Focus ring sits on the form (the
            input is outline-none) so the whole pill lights up. */}
        <form
          role="search"
          onSubmit={submitSearch}
          className="group hidden h-10 w-[360px] max-w-full items-center gap-2 rounded-full bg-surface-container px-4 focus-within:ring-2 focus-within:ring-primary lg:ml-2 lg:mr-auto lg:flex"
        >
          <Icon name="search" size={20} className="shrink-0 text-on-surface-variant" />
          <input
            data-desktop-search
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder={`Search ${CITY.name}…`}
            aria-label={`Search ${CITY.name}`}
            className="min-w-0 flex-1 bg-transparent text-body-md text-on-surface outline-none placeholder:text-on-surface-variant [&::-webkit-search-cancel-button]:hidden"
          />
          <kbd
            aria-hidden="true"
            className="rounded-sm border border-hairline-strong bg-surface-container-lowest px-1.5 text-label-sm font-semibold text-on-surface-variant group-focus-within:hidden"
          >
            /
          </kbd>
        </form>

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
            className="flex h-11 w-11 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface lg:hidden"
          >
            <Icon name="search" size={24} />
          </Link>
          {signedIn === true ? (
            // Saved moved here from the bottom nav (12 Oct 2026, "For you" took its tab).
            // Signed-in only: signed out it would just lead to a sign-in prompt.
            // On desktop it sits before the avatar (from lg the search field is
            // on the left, so there is no search icon beside it). It's the only
            // way to Saved on both sizes; the side nav doesn't repeat it.
            <Link
              href="/saved"
              aria-label="Saved"
              className="flex h-10 w-10 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
            >
              <Icon name="bookmark" size={24} />
            </Link>
          ) : null}
          {showInstallChip ? (
            // Icon-only until there's room for the words (480px: below that the
            // words pushed the right cluster over the wordmark); gone below 380px
            // (the Sign in pill is the wide neighbour it competes with).
            <button
              type="button"
              onClick={() => setInstallOpen(true)}
              aria-label="Get the app"
              className="flex h-10 items-center justify-center gap-1 rounded-full bg-primary-container/10 px-2.5 text-label-sm font-semibold text-primary transition-colors hover:bg-primary-container/20 max-[379px]:hidden"
            >
              <Icon name="install_mobile" size={18} />
              <span className="hidden min-[480px]:inline">Get the app</span>
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
              <UserAvatar size={32} />
            </Link>
          )}
        </div>
      </header>

      {title ? (
        <div className="px-4 pb-3 lg:px-8">
          <h1 className="truncate text-headline-sm text-primary lg:text-headline-md">{title}</h1>
        </div>
      ) : null}

      <InstallSheet open={installOpen} onClose={() => setInstallOpen(false)} source="header" />
    </div>
  );
}

export default AppHeader;
