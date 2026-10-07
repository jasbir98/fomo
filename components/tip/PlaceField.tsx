"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/ui";

interface Suggestion {
  placeId: string;
  primary: string;
  secondary: string | null;
}

export interface PlaceFieldProps {
  id: string;
  value: string;
  /** Typing: free text, and any earlier Google pick no longer applies. */
  onChange: (text: string) => void;
  /** A Google suggestion was picked. */
  onPick: (text: string, placeId: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * The tip form's "Where?" input: free text, with Google Places suggestions
 * (app/api/tips/places/route.ts) once 3+ characters are typed. Picking one
 * fills the box with "Name, area" and hands back the Google place id so the
 * reviewer gets an exact map link; ignoring the list keeps whatever was typed.
 */
export function PlaceField({ id, value, onChange, onPick, disabled, placeholder, className = "" }: PlaceFieldProps) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  // Set right after a pick so the effect doesn't re-search the label it just filled in.
  const pickedText = useRef<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const listboxId = useId();

  const q = value.trim();
  const visible = open && q.length >= 3 ? suggestions : [];

  // Debounced lookup, aborting the previous request so a slow answer for an
  // older query can't overwrite a newer one. Below 3 chars it does nothing;
  // `visible` already hides a stale batch.
  useEffect(() => {
    if (q.length < 3 || q === pickedText.current) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      (async () => {
        try {
          if (!sessionRef.current) sessionRef.current = crypto.randomUUID();
          const params = new URLSearchParams({ q, session: sessionRef.current });
          const res = await fetch(`/api/tips/places?${params.toString()}`, { signal: controller.signal });
          const data = (await res.json().catch(() => null)) as { suggestions?: Suggestion[] } | null;
          if (controller.signal.aborted) return;
          setSuggestions(data?.suggestions ?? []);
          setActiveIndex(-1);
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          // Suggestions are a nicety; the field still takes free text.
        }
      })();
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  function pick(s: Suggestion) {
    const text = s.secondary ? `${s.primary}, ${s.secondary}` : s.primary;
    pickedText.current = text;
    sessionRef.current = null; // A pick ends Google's session.
    setOpen(false);
    setSuggestions([]);
    onPick(text, s.placeId);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (visible.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % visible.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? visible.length - 1 : i - 1));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      pick(visible[activeIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        name="location_text"
        role="combobox"
        aria-expanded={visible.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        autoComplete="off"
        maxLength={200}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          pickedText.current = null;
          setOpen(true);
          onChange(e.target.value);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={handleKeyDown}
        className={`w-full ${className}`}
      />
      {visible.length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest shadow-level-2">
          <ul id={listboxId} role="listbox" aria-label="Places">
            {visible.map((s, i) => (
              <li
                key={s.placeId}
                id={`${listboxId}-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                // mousedown, not click: the input's blur would close the list first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                className={`flex cursor-pointer items-center gap-2 px-3 py-2.5 ${i === activeIndex ? "bg-surface-container" : "hover:bg-surface-container-low"}`}
              >
                <Icon name="place" size={18} className="shrink-0 text-on-surface-variant" />
                <span className="min-w-0">
                  <span className="block truncate text-body-md text-on-surface">{s.primary}</span>
                  {s.secondary ? <span className="block truncate text-label-sm text-on-surface-variant">{s.secondary}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-hairline px-3 py-1.5 text-right text-label-sm text-on-surface-variant">Suggestions from Google Maps</p>
        </div>
      ) : null}
    </div>
  );
}
