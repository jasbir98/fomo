"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useDeviceId } from "@/lib/device";
import { getItem, getTrip, updateItem } from "@/lib/db";
import type { Alternative, DisruptionAlert } from "@/lib/disruption";
import { WEATHER_THEME } from "@/lib/weatherUi";
import type { ItineraryItem } from "@/lib/types";
import { Button, Card, Icon, PageHeader } from "@/components/ui";

/**
 * Source: `smart_disruption_fix/code.html` for layout. Content is now real:
 * the alert banner and covered alternatives come from `/api/disruption`,
 * which combines a live Open-Meteo forecast for the item's day + trip
 * destination (`lib/weather.ts`) with real per-city covered picks
 * (`lib/disruption.ts`) — no more hardcoded Kyoto/Arashiyama copy. Swapping
 * an alternative in still updates the itinerary item in place; "Keep
 * original plan" just goes back.
 */

interface DisruptionResponse {
  alert: DisruptionAlert | null;
  alternatives: Alternative[];
  degraded?: string;
}

type LoadState = "loading" | "ready" | "not-found";

const DEGRADED_COPY: Record<string, string> = {
  "geocode-failed": "Couldn't locate this destination for a forecast — showing general suggestions.",
  "forecast-error": "Couldn't reach the weather service — showing covered suggestions anyway.",
  "no-google-key": "Showing curated picks only — add GOOGLE_PLACES_API_KEY for more live options.",
  "places-error": "Couldn't reach live places — showing curated picks only.",
};

export default function DisruptionPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const deviceId = useDeviceId();
  const id = params.id;

  const [state, setState] = useState<LoadState>("loading");
  const [item, setItem] = useState<ItineraryItem | null>(null);
  const [data, setData] = useState<DisruptionResponse | null>(null);
  const [swapping, setSwapping] = useState<string | null>(null);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;

    (async () => {
      try {
        const row = await getItem(deviceId, id);
        if (cancelled) return;
        if (!row) {
          setState("not-found");
          return;
        }
        setItem(row);

        // The item's own `location` is a specific spot (e.g. "Arashiyama
        // Bamboo Grove, Kyoto") which doesn't always geocode as cleanly as
        // the trip's destination and isn't what curated-place city matching
        // keys on elsewhere in the app (Home, /api/places) — so the trip's
        // destination drives both the forecast lookup and the alternatives
        // search, falling back to the item's location if the trip can't be
        // loaded for some reason.
        const trip = await getTrip(deviceId, row.trip_id).catch(() => null);
        const destination = trip?.destination ?? row.location ?? "Tokyo, Japan";

        const qs = new URLSearchParams({ destination });
        if (row.day_date) qs.set("date", row.day_date);
        if (row.title) qs.set("itemTitle", row.title);

        const res = await fetch(`/api/disruption?${qs.toString()}`);
        const json = (await res.json()) as DisruptionResponse;
        if (cancelled) return;
        setData(json);
        setState("ready");
      } catch (err) {
        console.error("[roameo] disruption load failed", err);
        // Fall through to the ready state with no data rather than a stuck
        // spinner — the page below renders sensible empty/degraded copy.
        if (!cancelled) setState("ready");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [deviceId, id]);

  async function swapIn(alt: Alternative) {
    if (!deviceId || swapping || !item) return;
    setSwapping(alt.title);
    try {
      await updateItem(deviceId, item.id, {
        title: alt.title,
        category: alt.category,
        location: alt.location,
        color_tag: "blue",
        weather_alert: false,
      });
      router.push("/plan");
    } catch (err) {
      console.error("[roameo] swap failed", err);
      setSwapping(null);
    }
  }

  if (!deviceId || state === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Icon name="thunderstorm" size={32} className="animate-pulse text-primary" />
      </div>
    );
  }

  if (state === "not-found" || !item) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-5 text-center">
        <p className="text-body-md text-on-surface-variant">This item couldn&apos;t be found.</p>
        <Button variant="outline" onClick={() => router.push("/plan")}>
          Back to Plan
        </Button>
      </div>
    );
  }

  const alert = data?.alert ?? null;
  const alternatives = data?.alternatives ?? [];
  const theme = alert ? WEATHER_THEME[alert.condition] : WEATHER_THEME.cloudy;
  const degradedCopy = data?.degraded ? DEGRADED_COPY[data.degraded] ?? "Some data couldn't load — showing what we have." : null;

  return (
    <div className={`flex min-h-dvh flex-col ${theme.bannerClass}`}>
      <PageHeader showBack centerTitle title={item.title ?? "Plan"} />

      <main className="flex flex-1 flex-col gap-6 px-5 pt-2 pb-[180px]">
        {/* Alert banner — real forecast, or a graceful "unavailable" state */}
        {alert ? (
          <div
            className={`flex items-start gap-4 rounded-xl p-4 shadow-sm ${
              alert.isDisruptive ? "bg-error-container" : "bg-surface-container-lowest"
            }`}
          >
            <Icon
              name={theme.icon}
              filled
              className={`mt-0.5 shrink-0 ${alert.isDisruptive ? "text-error" : theme.iconClass}`}
            />
            <div className="flex flex-col gap-1">
              <h2
                className={`text-label-md font-bold ${
                  alert.isDisruptive ? "text-on-error-container" : "text-on-surface"
                }`}
              >
                {alert.headline}
              </h2>
              <p
                className={`text-body-md ${
                  alert.isDisruptive ? "text-on-error-container/90" : "text-on-surface-variant"
                }`}
              >
                {alert.subtext}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-4 rounded-xl bg-surface-container-lowest p-4 shadow-sm">
            <Icon name="cloud_off" className="mt-0.5 shrink-0 text-on-surface-variant" />
            <div className="flex flex-col gap-1">
              <h2 className="text-label-md font-bold text-on-surface">Forecast unavailable</h2>
              <p className="text-body-md text-on-surface-variant">
                Couldn&apos;t reach the weather service right now — here are some covered options anyway.
              </p>
            </div>
          </div>
        )}

        {degradedCopy ? (
          <p className="text-label-sm text-on-surface-variant">{degradedCopy}</p>
        ) : null}

        {/* Suggestions */}
        <section className="flex flex-col gap-4">
          <div className="mb-1 flex items-center gap-2">
            <Icon name="smart_toy" filled size={20} className="text-primary" />
            <h3 className="text-headline-sm text-primary">Roameo suggests</h3>
          </div>

          {alternatives.length === 0 ? (
            <p className="text-body-md text-on-surface-variant">
              No covered alternatives found nearby yet — check the Map tab for more options.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {alternatives.map((alt) => (
                <Card key={alt.title} noPadding className="flex flex-col overflow-hidden">
                  <div className="relative h-32 w-full bg-surface-container-low">
                    {alt.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={alt.image_url}
                        alt={alt.title}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <Icon name="image" className="text-outline" />
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 p-4">
                    <h4 className="text-label-md font-bold text-on-surface">{alt.title}</h4>
                    <p className="text-body-md text-on-surface-variant">{alt.why}</p>
                    <p className="text-label-sm text-outline">
                      {[alt.distance_label, alt.duration_label, alt.location].filter(Boolean).join(" · ")}
                    </p>
                    <Button
                      variant="orange"
                      size="sm"
                      fullWidth
                      className="mt-2"
                      disabled={!!swapping}
                      onClick={() => swapIn(alt)}
                    >
                      {swapping === alt.title ? "Swapping…" : `Swap in ${alt.title}`}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* Fixed bottom action */}
      <div className="fixed bottom-0 left-1/2 z-40 w-full max-w-[480px] -translate-x-1/2 bg-surface-container-lowest/90 px-5 pb-safe pt-4 shadow-[0_-4px_16px_rgba(3,22,50,0.05)] backdrop-blur-md">
        <Button variant="outline" fullWidth onClick={() => router.back()} disabled={!!swapping}>
          Keep original plan
        </Button>
      </div>
    </div>
  );
}
