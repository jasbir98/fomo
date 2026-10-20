"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { CITY } from "@/lib/city";
import type { ExplorePin, MapPick } from "@/lib/explore/types";
import type { MapCanvasHandle } from "@/components/explore/MapCanvas";
import { useExploreState } from "@/lib/explore/useExploreState";
import { buildPicks, countResults, hasMappableResults } from "@/lib/explore/picks";
import {
  latestReplyResults,
  replyResults,
  useFomoChat,
  type ReplyResults,
  type UiAssistantMessage,
  type UseFomoChatOptions,
} from "@/lib/fomo-chat/useFomoChat";
import { tryOpenDetail } from "@/lib/detail-overlay/store";
import { AppHeader } from "@/components/shell/AppHeader";
import { ConfirmDialog, Icon } from "@/components/ui";
import { ChatComposer } from "@/components/fomo/chat/ChatComposer";
import { ChatThread } from "@/components/fomo/chat/ChatThread";
import { MapStatusPill, PlaceCardOverlay } from "@/components/explore/MapOverlays";
import type { ResolvedPlace } from "@/components/explore/SearchAutocomplete";
import { BROWSE_PAGE_SIZE, BrowsePanel } from "@/components/explore/desktop/BrowsePanel";

const MapStage = dynamic(() => import("@/components/explore/MapStage").then((mod) => mod.MapStage), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-surface-container" />,
});

type Tab = "ask" | "browse";

const NO_PICKS: MapPick[] = [];

/** How long a marker click keeps its chat card ringed once the pointer has moved on. */
const FOCUS_RING_MS = 2500;

export interface ExploreWorkspaceProps {
  /** Which panel opens first: /explore opens Browse, /fomo opens Ask Fomo. */
  initialTab: Tab;
  /** Passed straight to `useFomoChat` (seed, `?q=` prefill, `?q=…&send=1` auto-send). */
  chatOptions?: UseFomoChatOptions;
}

/** Scrolls the chat card with `key` into view inside `root`, preferring the one in reply `replyId`. */
function scrollCardIntoView(root: HTMLElement | null, key: string, replyId: string | null) {
  if (!root) return;
  const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-result-key]")).filter(
    (el) => el.dataset.resultKey === key
  );
  if (cards.length === 0) return;
  let target = cards[cards.length - 1];
  if (replyId) {
    const footer = Array.from(root.querySelectorAll<HTMLElement>("[data-reply-footer]")).find(
      (el) => el.dataset.replyFooter === replyId
    );
    const turn = footer?.parentElement;
    const inReply = turn ? cards.find((el) => turn.contains(el)) : undefined;
    if (inReply) target = inReply;
  }
  target.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/** One pick: fly in close; several: fit them all. */
function fitMapToPicks(handle: MapCanvasHandle | null, list: MapPick[]) {
  if (!handle || list.length === 0) return;
  if (list.length === 1) handle.flyTo({ lat: list[0].lat, lng: list[0].lng }, 15);
  else handle.fitToPins(list);
}

function scrollRowIntoView(root: HTMLElement | null, pinId: string) {
  if (!root) return;
  const row = Array.from(root.querySelectorAll<HTMLElement>("[data-pin-id]")).find((el) => el.dataset.pinId === pinId);
  row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/**
 * The desktop (>=1024px) Explore / Ask Fomo layout: a 420px side panel with
 * "Ask Fomo" and "Browse" tabs beside one full-height map. Both panels stay
 * mounted (the inactive one is `hidden`) so the chat input and scroll survive
 * a tab switch. Ask Fomo's latest reply is drawn on the map as numbered
 * "picks", linked to its chat cards by hover and click.
 */
export function ExploreWorkspace({ initialTab, chatOptions }: ExploreWorkspaceProps) {
  const router = useRouter();
  const explore = useExploreState();
  const chat = useFomoChat(chatOptions);
  const { mapRef } = explore;

  const idPrefix = useId();
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabButtonRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ ask: null, browse: null });
  const browseScrollRef = useRef<HTMLDivElement | null>(null);
  const askScrollRef = useRef<HTMLDivElement | null>(null);
  // `hidden` panels drop their scroll position in some browsers, so remember it across tab switches.
  const savedScroll = useRef<Record<Tab, { top: number; atBottom: boolean }>>({
    ask: { top: 0, atBottom: true },
    browse: { top: 0, atBottom: false },
  });
  const pendingCardScroll = useRef<{ key: string; replyId: string | null } | null>(null);

  const [mapReady, setMapReady] = useState(false);
  const [hoveredPinId, setHoveredPinId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(BROWSE_PAGE_SIZE);

  // --- Fomo's picks on the map -------------------------------------------
  // The Ask panel (or an earlier "Show on map" click) decides which reply is
  // on the map; replies loaded from history are not drawn on /explore until
  // the visitor opens the Ask tab or sends something (`engaged`).
  const [engaged, setEngaged] = useState(initialTab === "ask");
  if (!engaged && (tab === "ask" || chat.sending)) setEngaged(true);
  const [chosen, setChosen] = useState<{ replyId: string; latestAtChoice: string } | null>(null);
  const [dismissedReplyId, setDismissedReplyId] = useState<string | null>(null);
  const [showEverything, setShowEverything] = useState(false);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const latest = useMemo(() => latestReplyResults(chat.messages), [chat.messages]);
  const active = useMemo<ReplyResults | null>(() => {
    if (chosen && latest && chosen.latestAtChoice === latest.replyId) {
      const message = chat.messages.find((m) => m.id === chosen.replyId);
      const results = message && message.role === "assistant" ? replyResults(message) : null;
      if (results) return results;
    }
    return latest;
  }, [chosen, latest, chat.messages]);

  // Streaming rewrites `chat.messages` on every token. Round-tripping the picks
  // through a string keeps their identity (and so the map markers) stable until
  // the set of results actually changes.
  const picksJson = JSON.stringify(buildPicks(active));
  const allPicks = useMemo(() => JSON.parse(picksJson) as MapPick[], [picksJson]);
  const picksHidden = active !== null && dismissedReplyId === active.replyId;
  const picks = engaged && !picksHidden ? allPicks : NO_PICKS;
  const showPicksNote = engaged && active !== null && allPicks.length === 0;
  // Cards in the reply with no map location: the chip says "3 of 4" rather
  // than leave the visitor counting cards against pins.
  const resultCount = countResults(active);
  const highlightKey = hoverKey ?? focusKey;

  // Fit the map to the picks whenever the set changes (or the map first exists).
  useEffect(() => {
    if (mapReady) fitMapToPicks(mapRef.current, picks);
  }, [picks, mapReady, mapRef]);

  useEffect(
    () => () => {
      if (focusTimer.current) clearTimeout(focusTimer.current);
    },
    []
  );

  // --- Tabs ---------------------------------------------------------------
  const panelRefFor = (t: Tab) => (t === "ask" ? askScrollRef : browseScrollRef);

  function switchTab(next: Tab) {
    if (next === tab) return;
    const el = panelRefFor(tab).current;
    if (el) {
      savedScroll.current[tab] = {
        top: el.scrollTop,
        atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 40,
      };
    }
    setTab(next);
  }

  useEffect(() => {
    const el = (tab === "ask" ? askScrollRef : browseScrollRef).current;
    if (el) {
      const saved = savedScroll.current[tab];
      el.scrollTop = saved.atBottom && tab === "ask" ? el.scrollHeight : saved.top;
    }
    const pending = pendingCardScroll.current;
    if (tab === "ask" && pending) {
      pendingCardScroll.current = null;
      requestAnimationFrame(() => scrollCardIntoView(askScrollRef.current, pending.key, pending.replyId));
    }
  }, [tab]);

  function handleTabKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const order: Tab[] = ["ask", "browse"];
    let next: Tab | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") next = tab === "ask" ? "browse" : "ask";
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (!next) return;
    e.preventDefault();
    switchTab(next);
    tabButtonRefs.current[next]?.focus();
  }

  // --- Opening things -----------------------------------------------------
  function openDetail(href: string) {
    if (!tryOpenDetail(href)) router.push(href);
  }

  function revealRow(pin: ExplorePin) {
    const index = explore.sortedPins.findIndex((p) => p.id === pin.id);
    if (index >= visibleCount) setVisibleCount(index + BROWSE_PAGE_SIZE);
    // Two frames: the row may only just have been rendered by the line above.
    requestAnimationFrame(() => requestAnimationFrame(() => scrollRowIntoView(browseScrollRef.current, pin.id)));
  }

  /** A pin was clicked on the map: select it, bring its row into view and open its detail. */
  function handleMapPinClick(pin: ExplorePin) {
    explore.setSelectedPinId(pin.id);
    explore.setPlaceCard(null);
    revealRow(pin);
    openDetail(pin.href);
  }

  /** A browse row was clicked. */
  function handleRowOpen(pin: ExplorePin) {
    explore.setSelectedPinId(pin.id);
    explore.setPlaceCard(null);
    openDetail(pin.href);
  }

  // Search suggestions: same effect as a map pin click, plus the flyTo the
  // shared handler does. (The phone page opens its bottom sheet here.)
  function handleSelectPin(pin: ExplorePin) {
    explore.handleAutocompletePinSelect(pin);
    revealRow(pin);
    openDetail(pin.href);
  }

  function handleSelectGooglePlace(result: ResolvedPlace) {
    if (result.source === "fomo" && result.placeId) {
      const pin = explore.pins.find((p) => p.id === result.placeId);
      if (pin) {
        handleSelectPin(pin);
        return;
      }
    }
    explore.handleGooglePlaceSelect(result);
  }

  // --- Picks <-> chat cards -----------------------------------------------
  function handlePickClick(key: string) {
    setFocusKey(key);
    if (focusTimer.current) clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => setFocusKey(null), FOCUS_RING_MS);
    const replyId = active?.replyId ?? null;
    if (tab === "ask") {
      scrollCardIntoView(askScrollRef.current, key, replyId);
    } else {
      pendingCardScroll.current = { key, replyId };
      switchTab("ask");
    }
  }

  /** "Show on map" on a reply: make it the active one until a newer reply arrives. */
  function showOnMap(message: UiAssistantMessage) {
    setChosen({ replyId: message.id, latestAtChoice: latest?.replyId ?? message.id });
    setDismissedReplyId(null);
    setEngaged(true);
    fitMapToPicks(mapRef.current, buildPicks(replyResults(message)));
  }

  function renderReplyFooter(message: UiAssistantMessage) {
    if (!hasMappableResults(replyResults(message))) return null;
    const isShown = picks.length > 0 && active?.replyId === message.id;
    return (
      <div data-reply-footer={message.id} className="ml-10">
        <button
          type="button"
          aria-pressed={isShown}
          onClick={() => showOnMap(message)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-label-sm font-semibold transition-colors ${
            isShown
              ? "border-primary bg-primary text-on-primary"
              : "border-outline-variant/60 bg-surface text-on-surface-variant hover:bg-surface-container"
          }`}
        >
          <Icon name="map" size={16} filled={isShown} />
          {isShown ? "Showing on map" : "Show on map"}
        </button>
      </div>
    );
  }

  function handleItemClick(href: string, e: MouseEvent<HTMLAnchorElement>) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (tryOpenDetail(href)) e.preventDefault();
  }

  const picksInAsk = tab === "ask" && picks.length > 0;
  const emptyChat = chat.ready && chat.messages.length === 0;
  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "ask", label: "Ask Fomo", icon: "auto_awesome" },
    { id: "browse", label: "Browse", icon: "explore" },
  ];

  return (
    <>
      <AppHeader />
      {/* -1px: the header bar carries a 1px bottom border on top of --topbar-h. */}
      <div className="flex h-[calc(100dvh-var(--topbar-h)-1px)]">
        <aside
          aria-label="Explore panel"
          className="flex w-[420px] shrink-0 flex-col border-r border-hairline bg-surface-container-lowest"
        >
          <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
            <div
              role="tablist"
              aria-label="Explore panel"
              onKeyDown={handleTabKeyDown}
              className="flex flex-1 items-center gap-0.5 rounded-full bg-surface-container p-1"
            >
              {tabs.map((t) => {
                const selected = tab === t.id;
                return (
                  <button
                    key={t.id}
                    ref={(el) => {
                      tabButtonRefs.current[t.id] = el;
                    }}
                    id={`${idPrefix}-tab-${t.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`${idPrefix}-panel-${t.id}`}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => switchTab(t.id)}
                    className={`inline-flex min-h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-label-md font-medium transition-colors duration-200 ${
                      selected ? "bg-primary text-on-primary shadow-sm" : "text-on-surface-variant hover:text-on-surface"
                    }`}
                  >
                    <Icon name={t.icon} size={18} filled={selected} />
                    <span className="truncate">{t.label}</span>
                  </button>
                );
              })}
            </div>
            {chat.messages.length > 0 ? (
              <button
                type="button"
                aria-label="Clear chat"
                title="Clear chat"
                onClick={chat.requestClear}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container"
              >
                <Icon name="delete_outline" />
              </button>
            ) : null}
          </div>

          {/* Ask Fomo */}
          <div
            id={`${idPrefix}-panel-ask`}
            role="tabpanel"
            aria-labelledby={`${idPrefix}-tab-ask`}
            className={tab === "ask" ? "flex min-h-0 flex-1 flex-col" : "hidden"}
          >
            <div ref={askScrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
              <ChatThread
                messages={chat.messages}
                ready={chat.ready}
                sending={chat.sending}
                pendingStatus={chat.pendingStatus}
                pendingSeed={chat.pendingSeed}
                seed={chatOptions?.seed ?? null}
                loadFailed={chat.loadFailed}
                onQuickReply={(option) => void chat.send(option)}
                onItemHover={setHoverKey}
                highlightedKey={highlightKey}
                renderReplyFooter={renderReplyFooter}
                onItemClick={handleItemClick}
              />
              {emptyChat ? (
                <p className="text-center text-body-md text-on-surface-variant">
                  Ask anything — answers appear on the map.
                </p>
              ) : null}
            </div>
            <div className="shrink-0 border-t border-hairline">
              <ChatComposer
                layout="inline"
                input={chat.input}
                onInputChange={chat.setInput}
                onSend={(text) => void chat.send(text)}
                sending={chat.sending}
                exhausted={chat.exhausted}
                signedIn={chat.signedIn}
                quota={chat.quota}
                suggestions={chat.suggestions}
              />
            </div>
          </div>

          {/* Browse */}
          <div
            id={`${idPrefix}-panel-browse`}
            role="tabpanel"
            aria-labelledby={`${idPrefix}-tab-browse`}
            ref={browseScrollRef}
            className={tab === "browse" ? "min-h-0 flex-1 overflow-y-auto" : "hidden"}
          >
            <BrowsePanel
              search={explore.search}
              onSearchChange={explore.setSearch}
              pins={explore.pins}
              onSelectPin={handleSelectPin}
              onSelectGooglePlace={handleSelectGooglePlace}
              layer={explore.layer}
              onLayerChange={explore.handleLayerChange}
              neighbourhood={explore.neighbourhood}
              onNeighbourhoodSelect={explore.handleNeighbourhoodSelect}
              categories={explore.categories}
              onToggleCategory={explore.toggleCategory}
              sortedPins={explore.sortedPins}
              loading={explore.loading}
              degraded={explore.degraded}
              selectedPinId={explore.selectedPinId}
              onHoverPin={setHoveredPinId}
              onOpenPin={handleRowOpen}
              onWiden={explore.handleWidenSearch}
              isRainy={explore.isRainy}
              onCollectionSelect={explore.handleCollectionSelect}
              visibleCount={visibleCount}
              onShowMore={() => setVisibleCount((n) => n + BROWSE_PAGE_SIZE)}
            />
          </div>
        </aside>

        <div className="relative min-w-0 flex-1">
          <MapStage
            ref={mapRef}
            center={CITY.center}
            pins={explore.sortedPins}
            selectedPinId={explore.selectedPinId}
            onPinClick={handleMapPinClick}
            onBoundsChange={explore.setPendingBounds}
            showSearchThisArea={explore.pendingBounds !== null}
            onSearchThisArea={explore.handleSearchThisArea}
            onNearMe={explore.handleNearMe}
            nearMeAvailable={explore.geoStatus !== "denied" && explore.geoStatus !== "unsupported"}
            heightClassName="h-full"
            className="h-full"
            flush
            picks={picks}
            highlightedPickKey={highlightKey}
            onPickClick={handlePickClick}
            onPickHover={setHoverKey}
            onMapReady={() => setMapReady(true)}
            dimPins={picksInAsk && !showEverything}
            highlightedPinId={hoveredPinId}
          />

          {tab === "browse" && explore.showStatusPill ? (
            <MapStatusPill loading={explore.loading} onWiden={explore.handleWidenSearch} />
          ) : null}

          {explore.placeCard ? (
            <PlaceCardOverlay card={explore.placeCard} onDismiss={() => explore.setPlaceCard(null)} />
          ) : null}

          <div className="pointer-events-none absolute left-4 top-4 z-10 flex max-w-[calc(50%-1rem)] flex-col items-start gap-2">
            {picks.length > 0 && active ? (
              <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-surface-container-lowest/95 py-1 pl-3 pr-1 text-label-md font-semibold text-on-surface shadow-lg backdrop-blur-sm">
                <span
                  aria-hidden="true"
                  className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-on-primary"
                >
                  {picks.length}
                </span>
                <span>
                  Fomo&apos;s picks
                  {resultCount > picks.length ? (
                    <span className="font-normal text-on-surface-variant"> · {picks.length} of {resultCount} on map</span>
                  ) : null}
                </span>
                <button
                  type="button"
                  aria-label="Hide Fomo's picks"
                  onClick={() => setDismissedReplyId(active.replyId)}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container"
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            ) : null}
            {picksInAsk ? (
              <button
                type="button"
                aria-pressed={showEverything}
                onClick={() => setShowEverything((v) => !v)}
                className={`pointer-events-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-label-sm font-semibold shadow-lg backdrop-blur-sm transition-colors ${
                  showEverything
                    ? "bg-primary text-on-primary"
                    : "bg-surface-container-lowest/95 text-on-surface-variant hover:text-on-surface"
                }`}
              >
                <Icon name="layers" size={16} />
                Show everything else
              </button>
            ) : null}
            {showPicksNote ? (
              <div className="pointer-events-auto flex items-center gap-2 rounded-xl bg-surface-container-lowest/95 px-3 py-2 text-label-sm text-on-surface-variant shadow-lg backdrop-blur-sm">
                <Icon name="location_off" size={16} />
                <span>These results don&apos;t have map locations.</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={chat.clearDialogOpen}
        title="Clear chat?"
        description="This will permanently delete all messages in this conversation. You can't undo this."
        confirmLabel="Clear"
        cancelLabel="Cancel"
        danger
        busy={chat.clearing}
        onConfirm={() => void chat.clear()}
        onCancel={chat.cancelClear}
      />
    </>
  );
}

export default ExploreWorkspace;
