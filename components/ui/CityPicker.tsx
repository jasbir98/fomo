"use client";

import { BottomSheet } from "./BottomSheet";
import { Icon } from "./Icon";
import type { CityConfig } from "@/lib/city";
import type { CitySource } from "@/lib/useSelectedCity";

export type CityPickerProps = {
  open: boolean;
  onClose: () => void;
  /** Cities offered — pass `SUPPORTED_CITIES` from lib/city.ts, not a hand-picked subset. */
  cities: readonly CityConfig[];
  /** Currently active city's slug, highlighted in the list. */
  currentSlug?: string;
  /** How the active city was resolved — shown as a subtle subtitle, e.g. "Detected from your location". */
  currentSource?: CitySource;
  onSelect: (city: CityConfig) => void;
};

const SOURCE_LABEL: Record<CitySource, string> = {
  chosen: "Your choice",
  detected: "Detected from your location",
  default: "Default",
};

/**
 * BottomSheet listing every supported city — today just Edinburgh (Fomo is a
 * one-city app, see lib/city.ts's `SUPPORTED_CITIES` doc comment) — so a
 * denied/unavailable geolocation reading gets an explicit, rememberable
 * confirmation instead of a silent Edinburgh fallback. Structured like
 * components/fomo/LanguagePicker.tsx; a plain list rather than a searchable
 * one since `cities` is short.
 */
export function CityPicker({ open, onClose, cities, currentSlug, currentSource, onSelect }: CityPickerProps) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Choose your city">
      <div className="flex flex-col gap-1">
        {cities.length === 1 ? (
          <p className="px-3 pb-2 text-body-sm text-on-surface-variant">
            Fomo currently covers one city. More are on the way.
          </p>
        ) : null}
        {cities.map((city) => {
          const active = city.slug === currentSlug;
          return (
            <button
              key={city.slug}
              type="button"
              onClick={() => {
                onSelect(city);
                onClose();
              }}
              aria-current={active ? "true" : undefined}
              className={`flex items-center justify-between gap-3 rounded-xl px-3 py-3 text-left transition-colors ${
                active
                  ? "bg-primary-fixed/40 text-primary"
                  : "text-on-surface hover:bg-surface-container-low"
              }`}
            >
              <span className="flex flex-col">
                <span className="text-label-lg font-medium">{city.name}</span>
                <span className="text-label-sm text-on-surface-variant">
                  {active && currentSource ? SOURCE_LABEL[currentSource] : city.region}
                </span>
              </span>
              {active ? <Icon name="check_circle" size={20} filled className="text-primary" /> : null}
            </button>
          );
        })}
      </div>
    </BottomSheet>
  );
}

export default CityPicker;
