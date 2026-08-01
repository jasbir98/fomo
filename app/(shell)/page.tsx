"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useDeviceId } from "@/lib/device";
import { getCurrentTrip, getPreferences } from "@/lib/db";
import type { Trip } from "@/lib/types";
import { useGeolocation } from "@/lib/geo";
import { rememberDeviceLocation, forgetDeviceLocation } from "@/lib/now/location";
import type { CardKind, NowResponse } from "@/lib/now/types";
import type { WeatherCondition } from "@/lib/weather";
import { WEATHER_THEME } from "@/lib/weatherUi";
import { Icon } from "@/components/ui";
import { RoameoCard } from "@/components/roameo/Card";
import { TripSwitcher } from "@/components/shell/TripSwitcher";

type LoadStatus = "loading" | "redirecting" | "ready";

interface HomeWeather {
  condition: WeatherCondition;
  tempC: number | null;
}

function dayOfTrip(trip: Trip, at: Date): string | null {
  if (!trip.start_date) return null;
  const start = new Date(`${trip.start_date}T00:00:00`);
  const today = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const day = Math.floor((today.getTime() - start.getTime()) / 86_400_000) + 1;
  if (day < 1) return null;
  if (!trip.end_date) return `Day ${day}`;
  const end = new Date(`${trip.end_date}T00:00:00`);
  const total = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  return day > total ? null : `Day ${day} of ${total}`;
}

async function fetchNowResponse(
  deviceId: string,
  tripId: string,
  coords: { lat: number; lng: number } | null
): Promise<NowResponse | null> {
  try {
    const params = new URLSearchParams({ deviceId, tripId });
    if (coords) {
      params.set("lat", String(coords.lat));
      params.set("lng", String(coords.lng));
    }
    const res = await fetch(`/api/now?${params.toString()}`);
    return (await res.json()) as NowResponse;
  } catch (err) {
    console.error("[home] /api/now fetch failed", err);
    return null;
  }
}

/**
 * Roameo v1 Home — the "right now" surface (plan-v1-home-pivot.md §4).
 * Replaces the old distance-sorted nearby-places/events/experiences
 * dashboard entirely: one photo hero (top-ranked candidate from
 * GET /api/now), a next-anchor row, up to three intent chips, and a
 * horizontal photo rail. No other sections — that cap is deliberate, see §4.1.
 */
export default function TripHomePage() {
  const deviceId = useDeviceId();
  const router = useRouter();
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [trip, setTrip] = useState<Trip | null>(null);
  const [now, setNow] = useState<NowResponse | null>(null);
  const [weather, setWeather] = useState<HomeWeather | null>(null);
  const { coords, status: geoStatus } = useGeolocation();
  // Status line clock (plan-v1-home-pivot.md §4.1). Rendered null until
  // mounted so SSR and the first client paint agree — a live clock in the
  // initial HTML is a guaranteed hydration mismatch.
  const [clock, setClock] = useState<Date | null>(null);

  useEffect(() => {
    const tick = () => setClock(new Date());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const [currentTrip, prefs] = await Promise.all([
          getCurrentTrip(deviceId),
          getPreferences(deviceId),
        ]);
        if (cancelled) return;
        if (!currentTrip && !prefs) {
          setStatus("redirecting");
          router.replace("/onboarding");
          return;
        }
        setTrip(currentTrip);
        setStatus("ready");
      } catch (err) {
        console.error("[home] trip load failed", err);
        if (!cancelled) setStatus("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, router]);

  // Coarse last-known location, for graceful degradation on a later cold
  // open (plan-v1-home-pivot.md §10.3, §12) — not used for this request,
  // which sends the live reading directly.
  useEffect(() => {
    if (!deviceId) return;
    if (geoStatus === "granted" && coords) void rememberDeviceLocation(deviceId, coords.lat, coords.lng);
    else if (geoStatus === "denied") void forgetDeviceLocation(deviceId);
  }, [deviceId, geoStatus, coords]);

  useEffect(() => {
    if (!deviceId || !trip) return;
    let cancelled = false;
    (async () => {
      const json = await fetchNowResponse(deviceId, trip.id, coords);
      if (!cancelled && json) setNow(json);
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, trip, coords]);

  useEffect(() => {
    const destination = trip?.destination;
    if (!destination) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/weather?destination=${encodeURIComponent(destination)}`);
        const json = (await res.json()) as { day?: { condition: WeatherCondition; tempMaxC: number | null } | null };
        if (!cancelled && json.day) setWeather({ condition: json.day.condition, tempC: json.day.tempMaxC });
      } catch (err) {
        console.error("[home] weather fetch failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trip?.destination]);

  async function refresh() {
    if (!deviceId || !trip) return;
    const json = await fetchNowResponse(deviceId, trip.id, coords);
    if (json) setNow(json);
  }

  function handlePrimary(kind: CardKind) {
    if (kind === "location" && typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        () => void refresh(),
        () => {}
      );
    }
  }

  if (status !== "ready") {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Icon name="auto_awesome" size={32} className="animate-pulse text-primary" />
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-40 flex items-center gap-3 bg-background/90 px-5 pt-safe min-h-[48px] backdrop-blur-sm">
          <span className="flex h-10 w-10 items-center justify-center rounded-full text-on-surface-variant">
            <Icon name="explore" />
          </span>
          <h1 className="text-headline-sm text-primary">Roameo</h1>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary-fixed text-primary">
            <Icon name="luggage" size={40} filled />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-headline-md text-primary">No trips yet</h2>
            <p className="text-body-lg text-on-surface-variant">
              Create your first trip and Roameo will start planning with you.
            </p>
          </div>
          <Link
            href="/plan/new-trip"
            className="mt-2 inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-secondary-container px-6 text-label-md font-semibold text-on-secondary-container shadow-sm transition-opacity hover:opacity-90"
          >
            <Icon name="add" size={20} />
            Create your first trip
          </Link>
        </div>
      </div>
    );
  }

  const statusBits = [
    clock ? clock.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null,
    trip.destination?.split(",")[0]?.trim() || null,
    clock ? dayOfTrip(trip, clock) : null,
  ].filter((bit): bit is string => Boolean(bit));

  return (
    <div className="flex flex-col gap-5 pb-6">
      <header className="sticky top-0 z-40 flex flex-col gap-0.5 bg-background/90 px-5 pt-safe pb-1 backdrop-blur-sm">
        {/* Status line — clock · city · day n of m (plan-v1-home-pivot.md §4.1). */}
        <div className="flex items-center gap-1.5 text-label-sm text-on-surface-variant">
          {statusBits.map((bit, i) => (
            <span key={bit} className="flex items-center gap-1.5">
              {i > 0 ? <span aria-hidden className="text-outline-variant">·</span> : null}
              {bit}
            </span>
          ))}
        </div>
        <div className="flex items-center justify-between">
          <TripSwitcher currentTrip={trip} />
          <div className="flex items-center gap-3">
            <div
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 ${
                weather ? WEATHER_THEME[weather.condition].chipClass : "bg-surface-container-low text-on-surface-variant"
              }`}
            >
              <Icon name={weather ? WEATHER_THEME[weather.condition].icon : "partly_cloudy_day"} size={16} />
              <span className="text-label-sm">{weather?.tempC != null ? `${Math.round(weather.tempC)}°` : "—°"}</span>
            </div>
            <Link
              href="/profile"
              aria-label="Profile"
              className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-background bg-surface-container text-[10px] font-bold text-on-surface-variant"
            >
              YOU
            </Link>
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-5 px-5">
        {now?.hero ? (
          <RoameoCard
            candidate={now.hero}
            variant="hero"
            deviceId={deviceId}
            tripId={trip.id}
            onDismiss={() => void refresh()}
            onPrimary={handlePrimary}
          />
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-outline-variant/60 p-6 text-center">
            <Icon name="explore" size={28} className="text-outline" />
            <p className="text-body-md text-on-surface-variant">
              {now?.degraded === "no-coverage"
                ? `Roameo doesn't know ${trip.destination ?? "this area"} well yet — check the Map tab for live nearby places.`
                : "Getting your bearings…"}
            </p>
          </div>
        )}

        {now?.next ? (
          <Link
            href={now.next.kind === "anchor" && now.next.itemId ? `/plan/item/${now.next.itemId}` : "/plan/add"}
            className="flex items-center gap-3 rounded-xl border border-outline-variant/60 bg-surface-container-lowest p-2.5 transition-shadow hover:shadow-sm"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-container text-on-surface-variant">
              {now.next.image.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={now.next.image.url} alt="" className="h-full w-full object-cover" />
              ) : (
                // An empty grey disc reads as a failed image; the icon says
                // "there is nothing here yet", which is the actual state.
                <Icon name={now.next.kind === "anchor" ? "schedule" : "add_circle"} size={20} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-secondary">Next</p>
              <h4 className="truncate text-label-md font-bold text-primary">{now.next.title}</h4>
              <p className="truncate text-label-sm text-on-surface-variant">{now.next.subtitle}</p>
            </div>
            <Icon name="chevron_right" className="shrink-0 text-outline" />
          </Link>
        ) : null}

        {now?.chips && now.chips.length > 0 ? (
          // Outlined, not filled: three solid orange chips compete with the
          // hero's orange primary action, which is the one thing on Home that
          // should be shouting.
          <div className="flex gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden">
            {now.chips.map((chip) => (
              <Link
                key={chip.intent}
                href={`/discover/${chip.intent}`}
                className="flex shrink-0 items-center gap-1 rounded-full border border-outline-variant/60 bg-surface-container-lowest px-3.5 py-2 text-label-sm font-semibold text-primary transition-colors hover:bg-surface-container"
              >
                {chip.label}
                <Icon name="chevron_right" size={16} className="text-outline" />
              </Link>
            ))}
          </div>
        ) : null}

        {now?.rail && now.rail.items.length > 0 ? (
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-label-md font-bold text-primary">{now.rail.title}</h3>
              <span className="text-label-sm text-on-surface-variant">{now.rail.meta}</span>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory [&::-webkit-scrollbar]:hidden">
              {now.rail.items.map((item) => (
                <div key={`${item.subject.type}:${item.subject.id}`} className="w-[150px] shrink-0 snap-start">
                  <RoameoCard candidate={item} variant="tile" deviceId={deviceId} tripId={trip.id} />
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
