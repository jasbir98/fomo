"use client";

import { useEffect, useMemo, useState } from "react";
import type { WeatherCondition } from "@/lib/weather";

export interface AmbientWeatherProps {
  /** `null` while the weather chip itself hasn't loaded — renders nothing. */
  condition: WeatherCondition | null;
  /** Drives rain's light/heavy split. `null`/`undefined` falls back to "light". */
  precipitationProbabilityMax?: number | null;
  /** Reserved for a future windy-intensity split — currently unused (windy
   *  has one look), kept in the prop list so the caller doesn't have to
   *  special-case what it passes through from `lib/weather.ts`'s forecast. */
  windSpeedMaxKmh?: number | null;
  className?: string;
}

/** Hard ceiling on particles regardless of condition/intensity — an ambient
 *  decoration should never become a rendering cost anyone notices. */
const MAX_PARTICLES = 30;

// Every hook below defers its FIRST `setState` (reacting to a value that
// only exists client-side — matchMedia, the clock, `document.hidden`) into a
// microtask rather than calling it synchronously in the effect body. A
// synchronous set there trips react-hooks/set-state-in-effect (it can't
// distinguish "deriving state from a prop" from "reading a real external
// system for the first time"); every LATER set, from the actual
// change/visibilitychange listener callback, is already inside its own
// nested closure and isn't flagged.

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    queueMicrotask(() => setReduced(mq.matches));
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/** Pauses every particle's CSS animation while the tab is backgrounded —
 *  cheaper than unmounting (no re-generating particle layout on return) and
 *  stops a hidden tab from spending any animation-driven paint work at all. */
function useHidden(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    function onVisibility() {
      setHidden(document.hidden);
    }
    queueMicrotask(onVisibility);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  return hidden;
}

/** Coarse local-clock "is it dark out" check — good enough for picking
 *  stars-vs-glow on the `sunny` condition; this is decor, not the Smart
 *  Disruption flow's own sunrise/sunset logic, so a fixed 20:00–06:00 window
 *  is deliberately simpler than a real solar calculation. Computed once on
 *  mount (not on a ticking clock) — a visitor open past the boundary for
 *  hours would be an edge case not worth a timer for background flair. */
function useIsNight(): boolean {
  const [isNight, setIsNight] = useState(false);
  useEffect(() => {
    const hour = new Date().getHours();
    queueMicrotask(() => setIsNight(hour >= 20 || hour < 6));
  }, []);
  return isNight;
}

interface Particle {
  leftPct: number;
  delayS: number;
  durationS: number;
  /** Particle-type-specific extra (size, drift distance, twinkle offset…). */
  extra: number;
}

/** Deterministic pseudo-random particle layout — a fixed numeric seed rather
 *  than `Math.random()` so a re-render (e.g. `precipitationProbabilityMax`
 *  ticking the intensity band) doesn't jitter every particle's position, only
 *  the count. Not cryptographic, just a cheap LCG. */
function particles(count: number, seed: number): Particle[] {
  let state = seed;
  function next(): number {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  }
  return Array.from({ length: Math.min(count, MAX_PARTICLES) }, () => ({
    leftPct: next() * 100,
    delayS: next() * 6,
    durationS: 0, // filled in per-condition below
    extra: next(),
  }));
}

/**
 * Apple-Weather-style ambient background — a few slow, low-opacity particles
 * layered behind Home's header/hero content, themed off the same
 * `WeatherCondition` the header's weather chip already reads (lib/weatherUi's
 * `WEATHER_THEME`). The chip alone (a small "☁ 14°" pill) is easy to miss;
 * this makes "what's the weather doing" legible at a glance without
 * competing with the text above it — `pointer-events-none`, capped opacity,
 * and `aria-hidden` (the chip is still the one accessible weather readout).
 *
 * Pure CSS keyframe animation per particle (declared in app/globals.css),
 * driven by inline per-particle `--delay`/`--duration` custom properties
 * rather than one animation per distinct value — keeps the stylesheet fixed
 * size regardless of `MAX_PARTICLES`. `condition` has no `snow` state in
 * `lib/weather.ts` (Open-Meteo's code is bucketed into
 * sunny/cloudy/rainy/windy only) — windy gets its own faint streak look
 * rather than an invented snow one.
 */
export function AmbientWeather({
  condition,
  precipitationProbabilityMax,
  className = "",
}: AmbientWeatherProps) {
  const reducedMotion = useReducedMotion();
  const hidden = useHidden();
  const isNight = useIsNight();
  // Mount-gated: `useIsNight` reads the visitor's local clock, which the
  // server can't know — rendering nothing until after mount avoids a
  // hydration mismatch rather than trying to guess night-ness on the server.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  const heavyRain = (precipitationProbabilityMax ?? 0) >= 60;

  const rain = useMemo(() => {
    const count = heavyRain ? 22 : 10;
    return particles(count, 917).map((p) => ({ ...p, durationS: heavyRain ? 0.55 + p.extra * 0.25 : 1.1 + p.extra * 0.5 }));
  }, [heavyRain]);

  const stars = useMemo(() => particles(18, 42).map((p) => ({ ...p, durationS: 2.5 + p.extra * 2.5 })), []);
  const clouds = useMemo(() => particles(4, 271).map((p) => ({ ...p, durationS: 28 + p.extra * 14 })), []);
  const windStreaks = useMemo(() => particles(10, 733).map((p) => ({ ...p, durationS: 1.4 + p.extra * 0.8 })), []);

  if (!mounted || reducedMotion || !condition) return null;

  return (
    <div
      aria-hidden="true"
      data-paused={hidden ? "true" : undefined}
      className={`ambient-weather pointer-events-none absolute inset-x-0 top-0 overflow-hidden ${className}`}
    >
      {condition === "rainy"
        ? rain.map((p, i) => (
            <span
              key={i}
              className="ambient-raindrop"
              style={{ left: `${p.leftPct}%`, animationDelay: `${p.delayS}s`, animationDuration: `${p.durationS}s` }}
            />
          ))
        : null}

      {condition === "sunny" && !isNight ? <div className="ambient-sun-glow" /> : null}

      {condition === "sunny" && isNight
        ? stars.map((p, i) => (
            <span
              key={i}
              className="ambient-star"
              style={{
                left: `${p.leftPct}%`,
                top: `${(p.extra * 70).toFixed(2)}%`,
                animationDelay: `${p.delayS}s`,
                animationDuration: `${p.durationS}s`,
              }}
            />
          ))
        : null}

      {condition === "cloudy"
        ? clouds.map((p, i) => (
            <span
              key={i}
              className="ambient-cloud"
              style={{
                top: `${(p.extra * 55).toFixed(2)}%`,
                animationDelay: `${p.delayS}s`,
                animationDuration: `${p.durationS}s`,
              }}
            />
          ))
        : null}

      {condition === "windy"
        ? windStreaks.map((p, i) => (
            <span
              key={i}
              className="ambient-wind-streak"
              style={{
                top: `${(p.extra * 80).toFixed(2)}%`,
                animationDelay: `${p.delayS}s`,
                animationDuration: `${p.durationS}s`,
              }}
            />
          ))
        : null}
    </div>
  );
}

export default AmbientWeather;
