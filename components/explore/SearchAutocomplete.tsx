"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import type { ExplorePin } from "@/lib/explore/types";
import { Icon } from "@/components/ui";

export interface ResolvedPlace {
  source: "fomo" | "google";
  /** Present when `source === "fomo"` — our own `places` row id. */
  placeId?: string;
  name: string | null;
  address?: string | null;
  lat: number | null;
  lng: number | null;
}

interface GoogleSuggestion {
  placeId: string;
  primary: string;
  secondary: string | null;
}

export interface SearchAutocompleteProps {
  search: string;
  onSearchChange: (value: string) => void;
  /** Currently loaded pins (whatever layer/area/category is active) — source for the "On Fomo" group. */
  pins: ExplorePin[];
  /** "On Fomo" pick: page flies the map to it, selects it, and opens its sheet. */
  onSelectPin: (pin: ExplorePin) => void;
  /** "Places" (Google) pick, already resolved server-side — page decides fly-to vs. opening a cached pin's sheet. */
  onSelectGooglePlace: (result: ResolvedPlace) => void;
  placeholder?: string;
}

const MAX_FOMO_MATCHES = 4;

/** Flattened option list for keyboard nav across every group ("ask" is always last). */
type Option = { kind: "pin"; pin: ExplorePin } | { kind: "google"; suggestion: GoogleSuggestion } | { kind: "ask" };

/**
 * Explore's search box + suggestions dropdown. Two groups: "On Fomo" is an
 * instant, client-side title match over the pins already loaded for the
 * current layer/area — no network round trip. "Places" is Google Places
 * Autocomplete (New), debounced 250ms and session-tokened per Google's
 * billing model (server side: lib/places/autocomplete.ts via
 * app/api/places/autocomplete/route.ts).
 *
 * Selecting either option clears the search box rather than filling it with
 * the picked label: the result surfaces through the map (flyTo + the pin
 * sheet, or a small floating place card for a fresh Google pick) — setting
 * `search` to that text instead would just filter the pin list down to
 * (usually) nothing, fighting with the very result being shown.
 */
export function SearchAutocomplete({
  search,
  onSearchChange,
  pins,
  onSelectPin,
  onSelectGooglePlace,
  placeholder = "Search Edinburgh…",
}: SearchAutocompleteProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [googleSuggestions, setGoogleSuggestions] = useState<GoogleSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const sessionRef = useRef<string | null>(null);
  const listboxId = useId();

  const q = search.trim();
  const fomoMatches =
    q.length > 0 ? pins.filter((p) => p.title.toLowerCase().includes(q.toLowerCase())).slice(0, MAX_FOMO_MATCHES) : [];
  // `googleSuggestions` only ever holds results for a >=2-char query (the
  // fetch effect below never fires below that) — this just hides a stale
  // batch the instant the query is backspaced short again, without a
  // synchronous setState-in-effect to clear it (see that effect's own note).
  const visibleGoogleSuggestions = q.length >= 2 ? googleSuggestions : [];

  function ensureSession(): string {
    if (!sessionRef.current) sessionRef.current = crypto.randomUUID();
    return sessionRef.current;
  }

  // Debounced Google Autocomplete fetch, aborting the previous in-flight
  // request on every keystroke so a slow response for an earlier query can
  // never land after (and overwrite) a fresher one. Below 2 chars, this is a
  // no-op (no setState) rather than clearing `googleSuggestions` itself —
  // `visibleGoogleSuggestions` above already hides a stale batch for a short
  // query, and clearing state synchronously at the top of an effect body is
  // exactly the cascading-render pattern react-hooks/set-state-in-effect
  // flags.
  useEffect(() => {
    if (q.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      (async () => {
        try {
          const params = new URLSearchParams({ q, session: ensureSession() });
          const res = await fetch(`/api/places/autocomplete?${params.toString()}`, { signal: controller.signal });
          const data = (await res.json()) as { suggestions?: GoogleSuggestion[] };
          if (controller.signal.aborted) return;
          setGoogleSuggestions(data.suggestions ?? []);
          setActiveIndex(-1); // The option list just changed shape — drop any stale keyboard highlight.
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          console.error("[explore] autocomplete fetch failed", err);
        }
      })();
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  const options: Option[] = [
    ...fomoMatches.map((pin): Option => ({ kind: "pin", pin })),
    ...visibleGoogleSuggestions.map((suggestion): Option => ({ kind: "google", suggestion })),
    // Open questions ("cheap biryani") don't match a pin title; hand them to the AI.
    ...(q.length >= 2 ? [{ kind: "ask" } as Option] : []),
  ];
  const showDropdown = open && options.length > 0;
  const askIndex = options.length - 1;

  function selectPin(pin: ExplorePin) {
    setOpen(false);
    onSearchChange("");
    onSelectPin(pin);
  }

  async function selectGoogle(suggestion: GoogleSuggestion) {
    setOpen(false);
    onSearchChange("");
    const session = ensureSession();
    sessionRef.current = null; // Session ends at selection — Google's billing unit.
    try {
      const params = new URLSearchParams({ placeId: suggestion.placeId, session });
      const res = await fetch(`/api/places/resolve?${params.toString()}`);
      const data = (await res.json()) as ResolvedPlace & { message?: string };
      if (data.source === "fomo" || data.source === "google") onSelectGooglePlace(data);
    } catch (err) {
      console.error("[explore] place resolve failed", err);
    }
  }

  function askFomo() {
    setOpen(false);
    router.push(`/fomo?q=${encodeURIComponent(q)}&send=1`);
  }

  function selectOption(option: Option) {
    if (option.kind === "pin") selectPin(option.pin);
    else if (option.kind === "google") void selectGoogle(option.suggestion);
    else askFomo();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!showDropdown) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? options.length - 1 : i - 1));
    } else if (e.key === "Enter" && activeIndex >= 0 && activeIndex < options.length) {
      // Enter with nothing highlighted falls through to today's behaviour —
      // the free-text query already drives /api/explore?q= via `search`.
      e.preventDefault();
      selectOption(options[activeIndex]);
    }
  }

  return (
    <div className="relative">
      <div className="flex h-12 items-center gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest px-4 shadow-sm">
        <Icon name="search" size={20} className="text-primary" />
        <input
          type="text"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
          value={search}
          onChange={(e) => {
            onSearchChange(e.target.value);
            ensureSession();
            setOpen(true);
            setActiveIndex(-1); // "On Fomo" matches change on every keystroke — drop any stale highlight immediately.
          }}
          onFocus={() => {
            ensureSession();
            setOpen(true);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-body-md text-on-surface placeholder:text-on-surface-variant outline-none"
        />
        {search ? (
          <button
            type="button"
            aria-label="Clear search"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onSearchChange("");
              setOpen(false);
            }}
            className="text-on-surface-variant transition-colors hover:text-primary"
          >
            <Icon name="close" size={20} />
          </button>
        ) : null}
      </div>

      {showDropdown ? (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute inset-x-0 top-[calc(100%+4px)] z-30 flex max-h-80 flex-col gap-0.5 overflow-y-auto rounded-xl border border-outline-variant bg-surface-container-lowest p-1.5 shadow-lg"
        >
          {fomoMatches.length > 0 ? (
            <>
              <li role="presentation" className="px-2 pb-0.5 pt-1 text-label-sm font-semibold text-on-surface-variant">
                On Fomo
              </li>
              {fomoMatches.map((pin, i) => (
                <li key={pin.id} role="presentation">
                  <button
                    id={`${listboxId}-opt-${i}`}
                    role="option"
                    aria-selected={activeIndex === i}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectPin(pin)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-body-sm text-on-surface transition-colors ${
                      activeIndex === i ? "bg-surface-container" : "hover:bg-surface-container"
                    }`}
                  >
                    <Icon name="place" size={16} className="shrink-0 text-primary" />
                    <span className="truncate">{pin.title}</span>
                  </button>
                </li>
              ))}
            </>
          ) : null}

          {visibleGoogleSuggestions.length > 0 ? (
            <>
              <li role="presentation" className="px-2 pb-0.5 pt-1 text-label-sm font-semibold text-on-surface-variant">
                Places
              </li>
              {visibleGoogleSuggestions.map((s, gi) => {
                const i = fomoMatches.length + gi;
                return (
                  <li key={s.placeId} role="presentation">
                    <button
                      id={`${listboxId}-opt-${i}`}
                      role="option"
                      aria-selected={activeIndex === i}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void selectGoogle(s)}
                      className={`flex w-full flex-col items-start rounded-lg px-2.5 py-2 text-left transition-colors ${
                        activeIndex === i ? "bg-surface-container" : "hover:bg-surface-container"
                      }`}
                    >
                      <span className="truncate text-body-sm text-on-surface">{s.primary}</span>
                      {s.secondary ? (
                        <span className="truncate text-label-sm text-on-surface-variant">{s.secondary}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </>
          ) : null}

          {q.length >= 2 ? (
            <>
              {fomoMatches.length + visibleGoogleSuggestions.length > 0 ? (
                <li role="presentation" aria-hidden="true" className="mx-2 my-0.5 border-t border-hairline" />
              ) : null}
              <li role="presentation">
                <button
                  id={`${listboxId}-opt-${askIndex}`}
                  role="option"
                  aria-selected={activeIndex === askIndex}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={askFomo}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-body-sm font-semibold text-primary transition-colors ${
                    activeIndex === askIndex ? "bg-surface-container" : "hover:bg-surface-container"
                  }`}
                >
                  <Icon name="auto_awesome" size={16} className="shrink-0" />
                  <span className="truncate">Ask Fomo: &ldquo;{q}&rdquo;</span>
                </button>
              </li>
            </>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

export default SearchAutocomplete;
