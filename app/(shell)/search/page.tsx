"use client";

import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CITY } from "@/lib/city";
import type { ExplorePin, ExplorePinType, ExploreResponse } from "@/lib/explore/types";
import { Chip, FomoLogo, Icon, SmartImage } from "@/components/ui";
import { track } from "@/lib/analytics/track";

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;
const RECENT_KEY = "fomo:recent-searches";
const MAX_RECENT = 6;
/** Rows shown per group before "Show N more". */
const SECTION_CAP = 6;

const SUGGESTIONS = ["Free this weekend", "Student deals", "Cheap eats", "Live music"];

const SECTIONS: { type: ExplorePinType; label: string }[] = [
  { type: "deal", label: "Deals" },
  { type: "event", label: "What’s on" },
  { type: "free", label: "Free" },
  { type: "place", label: "Places" },
];

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: CITY.timezone,
  weekday: "short",
  day: "numeric",
  month: "short",
});

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string").slice(0, MAX_RECENT)
      : [];
  } catch {
    return [];
  }
}

function writeRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Private window / blocked storage: recents just don't stick.
  }
}

/** Thumbnail stand-in when a result has no photo. */
const PIN_ICON: Record<string, string> = { deal: "sell", event: "confirmation_number", free: "celebration", place: "place" };

function ResultRow({ pin, onOpen }: { pin: ExplorePin; onOpen: () => void }) {
  const when = pin.starts_at ? dateFormat.format(new Date(pin.starts_at)) : null;
  const meta = [pin.category, when].filter(Boolean).join(" · ");
  return (
    <Link
      href={pin.href}
      onClick={onOpen}
      className="flex items-center gap-3 rounded-xl py-2 transition-colors hover:bg-surface-container-low"
    >
      <SmartImage
        src={pin.image}
        alt=""
        width={56}
        height={56}
        className="h-14 w-14 shrink-0 rounded-lg object-cover"
        fallback={
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-surface-container text-on-surface-variant">
            <Icon name={PIN_ICON[pin.type] ?? "place"} size={24} />
          </span>
        }
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="line-clamp-2 text-body-md font-semibold text-on-surface">{pin.title}</span>
        {meta ? <span className="truncate text-label-sm text-on-surface-variant">{meta}</span> : null}
      </span>
      {pin.badge ? (
        <span className="shrink-0 rounded-full bg-secondary-container px-2.5 py-1 text-label-sm font-bold text-on-secondary-container">
          {pin.badge}
        </span>
      ) : null}
    </Link>
  );
}

function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex animate-pulse items-center gap-3 py-2">
          <div className="h-14 w-14 shrink-0 rounded-lg bg-surface-container" />
          <div className="flex flex-1 flex-col gap-2">
            <div className="h-4 w-3/4 rounded bg-surface-container" />
            <div className="h-3 w-1/2 rounded bg-surface-container" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SearchContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get("q") ?? "";
  const [query, setQuery] = useState(urlQuery);
  // What the fetch (and the URL) actually follow: the query, 250ms after typing stops.
  const [debounced, setDebounced] = useState(urlQuery.trim());
  // `pins: null` = the request failed.
  const [result, setResult] = useState<{ q: string; pins: ExplorePin[] | null } | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<ExplorePinType[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim();
  const searching = q.length >= MIN_QUERY;

  // Storage is read after mount, never during render, so the server HTML and
  // the first client render agree (same deferral as InstallHint).
  useEffect(() => {
    queueMicrotask(() => setRecent(readRecent()));
  }, []);

  // Debounce, then mirror the query into ?q= so the page is shareable and
  // survives a refresh. replace, not push: typing shouldn't build history.
  //
  // Opening a result pushes a detail URL on top of us via the desktop overlay
  // (lib/detail-overlay/store.ts), which this component stays mounted under.
  // That pushState changes `pathname`/`urlQuery` out from under this effect,
  // so a timer armed before the click would otherwise fire afterwards and
  // replace the detail URL back to /search?q=..., instantly closing the
  // overlay. Only touch the address bar while it's actually showing /search.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(q);
      if (pathname === "/search" && q !== urlQuery.trim()) {
        router.replace(q ? `/search?q=${encodeURIComponent(q)}` : "/search", { scroll: false });
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [q, urlQuery, router, pathname]);

  useEffect(() => {
    if (debounced.length < MIN_QUERY) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/explore?layer=everything&q=${encodeURIComponent(debounced)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`GET /api/explore ${res.status}`);
        const data = (await res.json()) as ExploreResponse;
        if (!controller.signal.aborted) {
          setResult({ q: debounced, pins: data.pins });
          setExpanded([]);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[search] fetch failed", err);
        setResult({ q: debounced, pins: null });
      }
    })();
    return () => controller.abort();
  }, [debounced]);

  function saveRecent(term: string) {
    const t = term.trim();
    if (t.length < MIN_QUERY) return;
    const next = [t, ...recent.filter((r) => r.toLowerCase() !== t.toLowerCase())].slice(0, MAX_RECENT);
    setRecent(next);
    writeRecent(next);
  }

  function clearRecent() {
    setRecent([]);
    writeRecent([]);
  }

  function fill(term: string) {
    setQuery(term);
    inputRef.current?.focus();
  }

  function handleBack() {
    if (window.history.length > 1) router.back();
    else router.push("/");
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!searching) return;
    saveRecent(q);
    setDebounced(q);
    inputRef.current?.blur();
  }

  // Only trust results for exactly what's been debounced; anything else is a
  // fetch in flight (or about to be), which reads as the skeleton.
  const settledResult = result !== null && result.q === debounced && debounced === q ? result : null;
  const settled = settledResult !== null;
  const pins = settledResult?.pins ?? null;
  const failed = settledResult !== null && settledResult.pins === null;

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="sticky top-0 z-40 border-b border-hairline bg-surface-container-lowest/95 pt-safe backdrop-blur-xl">
        <div className="flex items-center gap-1 px-2 py-2 lg:mx-auto lg:max-w-[900px]">
          <button
            type="button"
            onClick={handleBack}
            aria-label="Back"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-on-surface transition-colors hover:bg-surface-container"
          >
            <Icon name="arrow_back" size={24} />
          </button>
          <form onSubmit={handleSubmit} role="search" className="min-w-0 flex-1">
            <div className="flex h-11 items-center gap-2 rounded-full bg-surface-container px-4">
              <Icon name="search" size={20} className="shrink-0 text-on-surface-variant" />
              <input
                ref={inputRef}
                type="search"
                enterKeyHint="search"
                // Landing here is a tap on the search icon: the keyboard is the point.
                autoFocus
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search deals, events, places"
                aria-label="Search Fomo"
                className="min-w-0 flex-1 bg-transparent text-body-md text-on-surface outline-none placeholder:text-on-surface-variant [&::-webkit-search-cancel-button]:hidden"
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => fill("")}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:text-on-surface"
                >
                  <Icon name="close" size={20} />
                </button>
              ) : null}
            </div>
          </form>
        </div>
      </div>

      <div className="flex flex-col gap-4 px-4 py-4 lg:mx-auto lg:max-w-[900px] lg:px-8">
        {searching ? (
          <>
            <Link
              href={`/fomo?q=${encodeURIComponent(q)}&send=1`}
              onClick={() => {
                saveRecent(q);
                track("search_ask_fomo");
              }}
              className="flex items-center gap-3 rounded-xl border border-hairline bg-surface-container-lowest p-3 shadow-level-1 transition-colors hover:bg-surface-container-low"
            >
              <FomoLogo markOnly size={36} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body-md font-semibold text-on-surface">
                  Ask Fomo: &ldquo;{q}&rdquo;
                </span>
                <span className="text-label-sm text-on-surface-variant">Get an answer, including places nearby</span>
              </span>
              <Icon name="chevron_right" className="shrink-0 text-on-surface-variant" />
            </Link>

            {!settled ? (
              <ResultsSkeleton />
            ) : failed ? (
              <p className="py-6 text-center text-body-md text-on-surface-variant">
                Couldn&rsquo;t search just now. Give it another go.
              </p>
            ) : pins && pins.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-8 text-center">
                <p className="text-body-md font-semibold text-on-surface">
                  Nothing on Fomo for &ldquo;{q}&rdquo; yet.
                </p>
                <p className="text-body-md text-on-surface-variant">Ask Fomo above and it will look further afield.</p>
              </div>
            ) : (
              SECTIONS.map(({ type, label }) => {
                const group = (pins ?? []).filter((p) => p.type === type);
                if (group.length === 0) return null;
                const open = expanded.includes(type);
                const shown = open ? group : group.slice(0, SECTION_CAP);
                return (
                  <section key={type} className="flex flex-col gap-1">
                    <h2 className="text-label-md font-bold text-on-surface-variant">
                      {label} <span className="font-medium">({group.length})</span>
                    </h2>
                    {shown.map((pin) => (
                      <ResultRow
                        key={pin.id}
                        pin={pin}
                        onOpen={() => {
                          saveRecent(q);
                          track("search_result_opened", { type: pin.type });
                        }}
                      />
                    ))}
                    {group.length > shown.length ? (
                      <button
                        type="button"
                        onClick={() => setExpanded((cur) => [...cur, type])}
                        className="self-start rounded-full px-3 py-2 text-label-md font-semibold text-primary hover:bg-surface-container"
                      >
                        Show {group.length - shown.length} more
                      </button>
                    ) : null}
                  </section>
                );
              })
            )}
          </>
        ) : (
          <>
            {recent.length > 0 ? (
              <section className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <h2 className="text-label-md font-bold text-on-surface-variant">Recent</h2>
                  <button
                    type="button"
                    onClick={clearRecent}
                    className="rounded-full px-3 py-2 text-label-md font-semibold text-primary hover:bg-surface-container"
                  >
                    Clear
                  </button>
                </div>
                {recent.map((term) => (
                  <button
                    key={term}
                    type="button"
                    onClick={() => fill(term)}
                    className="flex min-h-11 items-center gap-3 rounded-xl px-1 text-left transition-colors hover:bg-surface-container-low"
                  >
                    <Icon name="history" size={20} className="shrink-0 text-on-surface-variant" />
                    <span className="truncate text-body-md text-on-surface">{term}</span>
                  </button>
                ))}
              </section>
            ) : null}

            <section className="flex flex-col gap-2">
              <h2 className="text-label-md font-bold text-on-surface-variant">Try</h2>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <Chip key={s} label={s} onClick={() => fill(s)} />
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchContent />
    </Suspense>
  );
}
