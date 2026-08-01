"use client";

import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BottomSheet, Button, Card, Chip, ConfirmDialog, Icon } from "@/components/ui";
import { useDeviceId } from "@/lib/device";
import {
  addMessage,
  clearMessages,
  createItem,
  deleteItem,
  getCurrentTrip,
  getPreferences,
  getRules,
  listItems,
  listMessages,
} from "@/lib/db";
import {
  getSuggestedPrompts,
  type ActionProposal,
  type AiReplyBlock,
  type ChatMode,
  type PlaceCard,
} from "@/lib/roameo-ai";
import { readChatSeed, suggestedQuestionsFor, type ChatSeed } from "@/lib/chat-seed";
import type { ChatMessage, TravelPreferences, Trip } from "@/lib/types";

/**
 * Minimal inline markdown for assistant/user chat text — no markdown library
 * in this project. Handles `**bold**` and `*italic*` only (the two forms the
 * system prompt's guidance tends to produce), splitting on a single regex
 * pass and mapping each matched span to `<strong>`/`<em>`. Bold is matched
 * before italic in the alternation so `**x**` never gets mis-split into two
 * italic halves.
 */
function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

/** Three-dot "thinking" indicator shown in place of the assistant bubble
 * while a reply is streaming in but no text has arrived yet. */
function ThinkingDots() {
  return (
    <div
      role="status"
      aria-label="Roameo is thinking"
      className="flex items-center gap-1 rounded-xl rounded-tl-sm border border-outline-variant/50 bg-surface px-5 py-4 shadow-[0_1px_3px_rgba(3,22,50,0.05)]"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 animate-bounce rounded-full bg-outline"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}

/**
 * UI-side message model. Parsed from `chat_messages.content` (jsonb):
 *   user turn      → content = { text: string }
 *   assistant turn → content = { blocks: AiReplyBlock[] }
 */
type UiMessage =
  | { id: string; role: "user"; mode: ChatMode; text: string }
  | { id: string; role: "assistant"; mode: ChatMode; blocks: AiReplyBlock[] };

/** Only the most recent turns are sent as API history — keeps each request's
 * token cost bounded instead of resending an ever-growing trip-long chat. */
const MAX_HISTORY_MESSAGES = 12;

const MODES: { value: ChatMode; label: string }[] = [
  { value: "translate", label: "Translate" },
  { value: "plan", label: "Plan" },
  { value: "explain", label: "Explain" },
  { value: "recommend", label: "Recommend" },
  { value: "emergency", label: "Emergency" },
];

/** Flatten an assistant turn's blocks to plain text for the API history. */
function blocksToText(blocks: AiReplyBlock[]): string {
  return blocks
    .map((b) => {
      if (b.kind === "text") return b.text;
      if (b.kind === "rich_card") return `[Suggested place: ${b.card.name}]`;
      if (b.kind === "quick_replies")
        return `[Quick replies offered: ${b.quick_replies.options.join(", ")}]`;
      return `[Proposed itinerary item: ${b.proposal.title}]`;
    })
    .filter(Boolean)
    .join("\n");
}

function parseMessage(m: ChatMessage): UiMessage {
  const mode = (m.mode ?? "plan") as ChatMode;
  if (m.role === "user") {
    const c = (m.content ?? {}) as { text?: string };
    return { id: m.id, role: "user", mode, text: c.text ?? "" };
  }
  const c = (m.content ?? {}) as { blocks?: AiReplyBlock[] };
  return { id: m.id, role: "assistant", mode, blocks: c.blocks ?? [] };
}

function createPendingId(): string {
  if (globalThis.crypto?.randomUUID) {
    return `pending-${globalThis.crypto.randomUUID()}`;
  }

  const randomPart = globalThis.crypto?.getRandomValues
    ? Array.from(globalThis.crypto.getRandomValues(new Uint32Array(2)), (n) =>
        n.toString(36)
      ).join("")
    : Math.random().toString(36).slice(2);

  return `pending-${Date.now().toString(36)}-${randomPart}`;
}

export default function RoameoChatPage() {
  return (
    <Suspense fallback={null}>
      <RoameoChatPageInner />
    </Suspense>
  );
}

function RoameoChatPageInner() {
  const deviceId = useDeviceId();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Ask Roameo seed (plan-v1-home-pivot.md §7) — set when this page was
  // opened from a card's "Ask Roameo" action rather than the plain FAB.
  // Drives the pinned context card, the suggested-question chips below, and
  // the system prompt's context (see the `seed` field on the /api/chat body).
  const seed: ChatSeed | null = useMemo(() => readChatSeed(searchParams), [searchParams]);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [preferences, setPreferences] = useState<TravelPreferences | null>(null);
  const [rules, setRules] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [mode, setMode] = useState<ChatMode>("plan");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState(false);
  // Maps a block key ("<messageId>:<blockIndex>") to the itinerary_items.id it
  // created, so an already-added card/proposal can be un-added later instead
  // of the "Added" state being a dead end with no way back.
  const [confirmed, setConfirmed] = useState<Map<string, string>>(new Map());
  // Keys with an add/remove mutation in flight — disables the relevant
  // button so a double tap can't fire two requests for the same card.
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [viewingCard, setViewingCard] = useState<{ key: string; card: PlaceCard } | null>(
    null
  );
  const [modeBanner, setModeBanner] = useState<string | null>(null);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const modeBannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // On mount: guarantee a trip (FK requires a non-null trip_id) + load history.
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const [t, prefs, rulesRow] = await Promise.all([
          getCurrentTrip(deviceId),
          getPreferences(deviceId),
          getRules(deviceId),
        ]);
        if (cancelled) return;
        setTrip(t);
        setPreferences(prefs);
        setRules(rulesRow?.rules_text ?? null);
        if (t) {
          const [history, items] = await Promise.all([
            listMessages(deviceId, t.id),
            listItems(deviceId, t.id),
          ]);
          if (cancelled) return;
          const parsedMessages = history.map(parseMessage);
          setMessages(parsedMessages);

          // Seed "already added" state from existing itinerary items so a
          // reload doesn't revert previously-confirmed cards/proposals back
          // to their clickable state (see bug #4) — match by title, the
          // only field both a card/proposal and an itinerary_items row share.
          // Also keep the matched row's id so it can be un-added later.
          const existingIdByTitle = new Map(
            items
              .filter((it): it is typeof it & { title: string } => !!it.title?.trim())
              .map((it) => [it.title.trim().toLowerCase(), it.id] as const)
          );
          const seeded = new Map<string, string>();
          for (const m of parsedMessages) {
            if (m.role !== "assistant") continue;
            m.blocks.forEach((block, i) => {
              const key = `${m.id}:${i}`;
              if (block.kind === "rich_card") {
                const id = existingIdByTitle.get(block.card.name.trim().toLowerCase());
                if (id) seeded.set(key, id);
              } else if (block.kind === "action_proposal") {
                const id = existingIdByTitle.get(block.proposal.title.trim().toLowerCase());
                if (id) seeded.set(key, id);
              }
            });
          }
          setConfirmed(seeded);
        }
      } catch (err) {
        console.error("[roameo] load failed", err);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  // Clear any pending mode-banner timeout on unmount.
  useEffect(() => {
    return () => {
      if (modeBannerTimer.current) clearTimeout(modeBannerTimer.current);
    };
  }, []);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !deviceId || !trip || sending) return;
    const currentMode = mode;
    setSending(true);
    setInput("");

    // Snapshot the conversation before this turn for the API history — capped
    // to the most recent messages so token cost doesn't grow with the whole
    // trip's chat history.
    const history = messages.slice(-MAX_HISTORY_MESSAGES).map((m) =>
      m.role === "user"
        ? { role: "user" as const, text: m.text }
        : { role: "assistant" as const, text: blocksToText(m.blocks) }
    );

    const provisionalId = createPendingId();

    try {
      // Persist + append the user turn.
      const userRow = await addMessage(deviceId, {
        trip_id: trip.id,
        role: "user",
        mode: currentMode,
        content: { text: trimmed },
      });
      setMessages((prev) => [
        ...prev,
        { id: userRow.id, role: "user", mode: currentMode, text: trimmed },
        // Provisional assistant turn — grows as text streams in.
        {
          id: provisionalId,
          role: "assistant",
          mode: currentMode,
          blocks: [{ kind: "text", text: "" }],
        },
      ]);

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: currentMode,
          history,
          userText: trimmed,
          trip: {
            destination: trip.destination,
            name: trip.name,
            start_date: trip.start_date,
            end_date: trip.end_date,
          },
          preferences,
          rules,
          seed: seed ? { type: seed.type, name: seed.name, city: seed.city ?? null } : null,
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`chat request failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamedText = "";
      let finalBlocks: AiReplyBlock[] | null = null;
      let errored = false;

      const updateProvisional = (blocks: AiReplyBlock[]) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === provisionalId && m.role === "assistant"
              ? { ...m, blocks }
              : m
          )
        );
      };

      // Consume newline-delimited JSON events.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          if (!line) continue;
          const event = JSON.parse(line) as
            | { type: "text_delta"; text: string }
            | { type: "done"; blocks: AiReplyBlock[] }
            | { type: "error"; message: string };
          if (event.type === "text_delta") {
            streamedText += event.text;
            updateProvisional([{ kind: "text", text: streamedText }]);
          } else if (event.type === "done") {
            finalBlocks = event.blocks;
          } else if (event.type === "error") {
            errored = true;
            updateProvisional([{ kind: "text", text: event.message }]);
          }
        }
      }

      if (finalBlocks && !errored) {
        // Persist the fully-assembled assistant turn, then swap the
        // provisional message for the persisted row (real id + final blocks).
        const aiRow = await addMessage(deviceId, {
          trip_id: trip.id,
          role: "assistant",
          mode: currentMode,
          content: { blocks: finalBlocks },
        });
        setMessages((prev) =>
          prev.map((m) =>
            m.id === provisionalId && m.role === "assistant"
              ? {
                  id: aiRow.id,
                  role: "assistant",
                  mode: currentMode,
                  blocks: finalBlocks as AiReplyBlock[],
                }
              : m
          )
        );
      } else if (!errored) {
        // Stream ended without a done event — show a fallback in place.
        updateProvisional([
          {
            kind: "text",
            text: "Roameo didn't finish that reply. Please try again.",
          },
        ]);
      }
    } catch (err) {
      console.error("[roameo] send failed", err);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === provisionalId && m.role === "assistant"
            ? {
                ...m,
                blocks: [
                  {
                    kind: "text",
                    text: "Roameo hit a snag. Please try again in a moment.",
                  },
                ],
              }
            : m
        )
      );
    } finally {
      setSending(false);
    }
  }

  function clearActionError(key: string) {
    setActionErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function confirmProposal(key: string, p: ActionProposal) {
    if (confirmed.has(key) || pendingKeys.has(key)) return;
    if (!deviceId || !trip) {
      setActionErrors((prev) => ({
        ...prev,
        [key]: "Couldn't add — trip isn't loaded yet. Try again in a moment.",
      }));
      return;
    }
    setPendingKeys((prev) => new Set(prev).add(key));
    try {
      const created = await createItem(deviceId, {
        trip_id: trip.id,
        title: p.title,
        category: p.category,
        location: p.location,
        day_date: p.day_date ?? trip.start_date ?? "2026-03-28",
        time_label: p.time_label ?? null,
      });
      setConfirmed((prev) => new Map(prev).set(key, created.id));
      clearActionError(key);
    } catch (err) {
      console.error("[roameo] confirm failed", err);
      setActionErrors((prev) => ({
        ...prev,
        [key]: "Couldn't add to itinerary. Please try again.",
      }));
    } finally {
      setPendingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function addCardToItinerary(key: string, card: PlaceCard) {
    if (confirmed.has(key) || pendingKeys.has(key)) return;
    if (!deviceId || !trip) {
      setActionErrors((prev) => ({
        ...prev,
        [key]: "Couldn't add — trip isn't loaded yet. Try again in a moment.",
      }));
      return;
    }
    setPendingKeys((prev) => new Set(prev).add(key));
    try {
      const created = await createItem(deviceId, {
        trip_id: trip.id,
        title: card.name,
        category: card.category,
        location: card.name,
        day_date: trip.start_date ?? "2026-03-28",
        time_label: null,
      });
      setConfirmed((prev) => new Map(prev).set(key, created.id));
      clearActionError(key);
    } catch (err) {
      console.error("[roameo] add place to itinerary failed", err);
      setActionErrors((prev) => ({
        ...prev,
        [key]: "Couldn't add to itinerary. Please try again.",
      }));
    } finally {
      setPendingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  /** Un-add a previously confirmed card/proposal (bug: no way to remove an
   * itinerary item once added). Reuses `deleteItem`, the existing itinerary
   * removal function in lib/db/items.ts — no new DB-layer code needed. */
  async function removeFromItinerary(key: string) {
    const itemId = confirmed.get(key);
    if (!deviceId || !itemId || pendingKeys.has(key)) return;
    setPendingKeys((prev) => new Set(prev).add(key));
    try {
      await deleteItem(deviceId, itemId);
      setConfirmed((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      clearActionError(key);
    } catch (err) {
      console.error("[roameo] remove from itinerary failed", err);
      setActionErrors((prev) => ({
        ...prev,
        [key]: "Couldn't remove from itinerary. Please try again.",
      }));
    } finally {
      setPendingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  /** Switching modes shows a fresh view (prior messages stay persisted
   * server-side — see lib/db/chat.ts — this only resets the client view) and
   * a brief banner so the mode change is visibly obvious (bug #5). */
  function handleModeChange(next: ChatMode) {
    if (next === mode) return;
    setMode(next);
    setMessages([]);
    setConfirmed(new Map());
    setPendingKeys(new Set());
    setDismissed(new Set());
    setActionErrors({});
    setViewingCard(null);
    const label = MODES.find((m) => m.value === next)?.label ?? next;
    setModeBanner(`${label} mode`);
    if (modeBannerTimer.current) clearTimeout(modeBannerTimer.current);
    modeBannerTimer.current = setTimeout(() => setModeBanner(null), 2500);
  }

  /** Clear all chat messages for the current trip from the database and client. */
  async function handleClearChat() {
    if (!deviceId || !trip) return;
    setClearing(true);
    try {
      await clearMessages(deviceId, trip.id);
      setMessages([]);
      setConfirmed(new Map());
      setPendingKeys(new Set());
      setDismissed(new Set());
      setActionErrors({});
      setViewingCard(null);
      setClearDialogOpen(false);
    } catch (err) {
      console.error("[roameo] clear chat failed", err);
    } finally {
      setClearing(false);
    }
  }

  const suggestions = seed ? suggestedQuestionsFor(seed.type) : getSuggestedPrompts(mode);
  const empty = ready && messages.length === 0;

  // Chat needs a trip (messages FK to trip_id + the AI is grounded in it).
  if (ready && !trip) {
    return (
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-40 flex items-center gap-2 bg-background/90 px-5 min-h-[56px] pt-safe backdrop-blur-sm">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-on-primary shadow-sm">
            <Icon name="auto_awesome" filled size={18} />
          </span>
          <h1 className="text-headline-sm text-primary">Roameo</h1>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary-fixed text-primary">
            <Icon name="auto_awesome" size={40} filled />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-headline-md text-primary">Start a trip first</h2>
            <p className="text-body-lg text-on-surface-variant">
              Roameo plans around your destination and dates. Create a trip and
              we&rsquo;ll get going.
            </p>
          </div>
          <Link
            href="/plan/new-trip"
            className="mt-2 inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-secondary-container px-6 text-label-md font-semibold text-on-secondary-container shadow-sm transition-opacity hover:opacity-90"
          >
            <Icon name="add" size={20} />
            Create a trip
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Top app bar with a Translator entry action + Clear chat menu */}
      <header className="sticky top-0 z-40 flex items-center justify-between gap-2 bg-background/90 px-5 min-h-[56px] pt-safe backdrop-blur-sm">
        <div className="flex items-center gap-2">
          {seed ? (
            <button
              type="button"
              aria-label="Back"
              onClick={() => router.push(seed.returnTo)}
              className="flex h-8 w-8 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-low"
            >
              <Icon name="arrow_back" />
            </button>
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-on-primary shadow-sm">
              <Icon name="auto_awesome" filled size={18} />
            </span>
          )}
          <h1 className="text-headline-sm text-primary">Roameo</h1>
        </div>
        <div className="flex items-center gap-1">
          <Link
            href="/roameo/translator"
            aria-label="Open Translator"
            className="flex h-10 w-10 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-low"
          >
            <Icon name="translate" />
          </Link>
          <button
            type="button"
            aria-label="Clear chat"
            onClick={() => setClearDialogOpen(true)}
            className="flex h-10 w-10 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-low"
          >
            <Icon name="delete_outline" />
          </button>
        </div>
      </header>

      {/* Mode chips */}
      <div className="sticky top-[56px] z-30 bg-background/90 backdrop-blur-sm">
        <div className="no-scrollbar flex gap-2 overflow-x-auto px-5 py-2">
          {MODES.map((m) => {
            const isEmergency = m.value === "emergency";
            const active = m.value === mode;
            return (
              <Chip
                key={m.value}
                label={m.label}
                selected={active}
                onClick={() => handleModeChange(m.value)}
                className={
                  isEmergency
                    ? active
                      ? "!bg-error !text-on-error !border-error"
                      : "!bg-error-container !text-on-error-container !border-error-container"
                    : ""
                }
              />
            );
          })}
        </div>
      </div>

      {/* Mode-switch banner — brief, so the transition is obviously visible */}
      {modeBanner ? (
        <div
          className={`mx-5 mt-2 rounded-lg px-3 py-1.5 text-center text-label-sm font-semibold ${
            mode === "emergency"
              ? "bg-error-container text-on-error-container"
              : "bg-surface-container text-on-surface-variant"
          }`}
        >
          {modeBanner}
        </div>
      ) : null}

      {/* Seed context card (plan-v1-home-pivot.md §7) — pinned so it's
          obvious what Roameo is talking about when opened from a card. */}
      {seed ? (
        <div className="mx-5 mt-3 flex items-center gap-2.5 rounded-xl border border-outline-variant/60 bg-surface-container-lowest p-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-fixed text-primary">
            <Icon
              name={
                seed.type === "event" ? "event" : seed.type === "experience" ? "confirmation_number" : seed.type === "reel" ? "movie" : "location_on"
              }
              size={18}
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-label-md font-bold text-primary">{seed.name}</p>
            {seed.city ? <p className="text-label-sm text-on-surface-variant">{seed.city}</p> : null}
          </div>
        </div>
      ) : null}

      {/* Message list */}
      <main className="flex flex-1 flex-col gap-6 px-5 pt-4 pb-[220px]">
        {empty ? (
          <div className="mt-8 flex flex-col items-center gap-3 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-on-primary shadow-md">
              <Icon name="auto_awesome" filled size={28} />
            </span>
            <p className="text-body-lg text-on-surface">
              {seed ? `Ask me anything about ${seed.name}.` : "Ask Roameo anything about your trip."}
            </p>
            <p className="text-body-md text-on-surface-variant">
              {seed ? "Try one of these, or type your own." : "Pick a mode above, then try a suggestion below."}
            </p>
          </div>
        ) : null}

        {messages.map((m, mi) => {
          if (m.role === "user") return <UserBubble key={m.id} text={m.text} />;
          const isProvisional =
            sending &&
            mi === messages.length - 1 &&
            m.blocks.length === 1 &&
            m.blocks[0].kind === "text" &&
            m.blocks[0].text === "";
          if (isProvisional) {
            return (
              <div key={m.id} className="flex items-end gap-2 self-start max-w-[90%]">
                <span className="mb-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary shadow-md">
                  <Icon name="auto_awesome" filled size={18} />
                </span>
                <ThinkingDots />
              </div>
            );
          }
          return (
            <AssistantTurn
              key={m.id}
              messageId={m.id}
              mode={m.mode}
              blocks={m.blocks}
              confirmed={confirmed}
              removing={pendingKeys}
              dismissed={dismissed}
              errors={actionErrors}
              onConfirm={confirmProposal}
              onView={(key, card) => setViewingCard({ key, card })}
              onRemove={(key) => void removeFromItinerary(key)}
              onDismiss={(key) =>
                setDismissed((prev) => new Set(prev).add(key))
              }
              onQuickReply={(option) => void send(option)}
            />
          );
        })}
        <div ref={endRef} />
      </main>

      {/* Composer: suggested prompts + input bar, fixed above the bottom nav */}
      <div className="fixed bottom-[64px] left-1/2 z-40 w-full max-w-[480px] -translate-x-1/2 bg-gradient-to-t from-background via-background to-transparent px-5 pb-3 pt-6">
        {mode === "translate" ? (
          <Link
            href="/roameo/translator"
            className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-surface px-3.5 py-1.5 text-label-sm font-semibold text-primary shadow-sm transition-colors hover:bg-surface-container"
          >
            <Icon name="graphic_eq" size={16} />
            Open full Translator
          </Link>
        ) : null}

        {suggestions.length > 0 ? (
          <p
            className={`mb-1 px-1 text-label-sm font-medium ${
              mode === "emergency" ? "text-on-error-container" : "text-on-surface-variant"
            }`}
          >
            Try asking:
          </p>
        ) : null}
        <div className="no-scrollbar mb-2 flex gap-2 overflow-x-auto">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void send(s)}
              disabled={sending}
              className={`whitespace-nowrap rounded-full border px-4 py-1.5 text-label-sm font-semibold transition-colors disabled:opacity-40 ${
                mode === "emergency"
                  ? "border-error-container bg-error-container text-on-error-container hover:opacity-90"
                  : "border-outline-variant/60 bg-surface text-on-surface-variant hover:bg-surface-container"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <div
          className={`flex items-end gap-2 rounded-2xl border p-2 shadow-[0_2px_12px_rgba(3,22,50,0.06)] focus-within:ring-1 ${
            mode === "emergency"
              ? "border-error-container bg-error-container/15 focus-within:border-error focus-within:ring-error"
              : "border-outline-variant/60 bg-surface focus-within:border-primary focus-within:ring-primary"
          }`}
        >
          <button
            type="button"
            aria-label="Add photo (coming soon)"
            aria-disabled="true"
            disabled
            title="Coming soon"
            className="mb-0.5 shrink-0 rounded-full p-2.5 text-on-surface-variant opacity-40 transition-colors disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <Icon name="add_photo_alternate" />
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={1}
            placeholder="Ask Roameo anything..."
            className="max-h-[120px] min-h-[44px] flex-1 resize-none border-none bg-transparent p-2 text-body-md text-on-surface outline-none placeholder:text-outline focus:ring-0"
          />
          <button
            type="button"
            aria-label="Voice input (coming soon)"
            aria-disabled="true"
            disabled
            title="Coming soon"
            className="mb-0.5 shrink-0 rounded-full p-2.5 text-on-surface-variant opacity-40 transition-colors disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <Icon name="mic" />
          </button>
          <button
            type="button"
            aria-label="Send"
            onClick={() => void send(input)}
            disabled={sending || !input.trim()}
            className="shrink-0 rounded-xl bg-secondary-container p-3 text-on-secondary-container shadow-sm transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <Icon name="arrow_upward" filled />
          </button>
        </div>
      </div>

      {/* Clear chat confirmation dialog */}
      <ConfirmDialog
        open={clearDialogOpen}
        title="Clear chat?"
        description="This will permanently delete all messages in this conversation. You can't undo this."
        confirmLabel="Clear"
        cancelLabel="Cancel"
        danger
        busy={clearing}
        onConfirm={() => void handleClearChat()}
        onCancel={() => setClearDialogOpen(false)}
      />

      {/* Place card detail modal — the only place "Add to itinerary" can be
          triggered from for a rich_card (see bug: whole card used to be
          treated as tappable with no separate view step). */}
      <PlaceCardModal
        entry={viewingCard}
        onClose={() => setViewingCard(null)}
        added={viewingCard ? confirmed.has(viewingCard.key) : false}
        removing={viewingCard ? pendingKeys.has(viewingCard.key) : false}
        error={viewingCard ? actionErrors[viewingCard.key] : undefined}
        onAdd={() => viewingCard && addCardToItinerary(viewingCard.key, viewingCard.card)}
        onRemove={() => viewingCard && removeFromItinerary(viewingCard.key)}
      />
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="self-end max-w-[85%] rounded-xl rounded-tr-sm bg-primary px-5 py-3 text-on-primary shadow-sm">
      <p className="whitespace-pre-wrap text-body-md">{renderInlineMarkdown(text)}</p>
    </div>
  );
}

function AssistantTurn({
  messageId,
  mode,
  blocks,
  confirmed,
  removing,
  dismissed,
  errors,
  onConfirm,
  onView,
  onRemove,
  onDismiss,
  onQuickReply,
}: {
  messageId: string;
  mode: ChatMode;
  blocks: AiReplyBlock[];
  confirmed: Map<string, string>;
  removing: Set<string>;
  dismissed: Set<string>;
  errors: Record<string, string>;
  onConfirm: (key: string, p: ActionProposal) => void;
  onView: (key: string, card: PlaceCard) => void;
  onRemove: (key: string) => void;
  onDismiss: (key: string) => void;
  onQuickReply: (option: string) => void;
}) {
  const isEmergency = mode === "emergency";
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, i) => {
        const key = `${messageId}:${i}`;
        if (block.kind === "text") {
          return (
            <div key={key} className="flex items-end gap-2 self-start max-w-[90%]">
              <span className="mb-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary shadow-md">
                <Icon name="auto_awesome" filled size={18} />
              </span>
              <div className="rounded-xl rounded-tl-sm border border-outline-variant/50 bg-surface px-5 py-4 text-on-surface shadow-[0_1px_3px_rgba(3,22,50,0.05)]">
                <p className="whitespace-pre-wrap text-body-md">
                  {renderInlineMarkdown(block.text)}
                </p>
              </div>
            </div>
          );
        }
        if (block.kind === "rich_card") {
          return (
            <div key={key} className="ml-10 self-start flex w-full max-w-[340px] flex-col gap-1.5">
              {block.card.reason ? (
                <p className="px-1 text-label-sm italic text-on-surface-variant">
                  {block.card.reason}
                </p>
              ) : null}
              <RichPlaceCard
                card={block.card}
                added={confirmed.has(key)}
                error={errors[key]}
                onView={() => onView(key, block.card)}
              />
            </div>
          );
        }
        if (block.kind === "quick_replies") {
          return (
            <div key={key} className="ml-10 self-start flex w-full max-w-[400px] flex-col gap-1.5">
              {block.quick_replies.prompt ? (
                <p
                  className={`px-1 text-label-sm font-medium ${
                    isEmergency ? "text-on-error-container" : "text-on-surface-variant"
                  }`}
                >
                  {block.quick_replies.prompt}
                </p>
              ) : (
                <p
                  className={`px-1 text-label-sm font-medium ${
                    isEmergency ? "text-on-error-container" : "text-on-surface-variant"
                  }`}
                >
                  Try one of these:
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {block.quick_replies.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onQuickReply(option)}
                    className={`whitespace-nowrap rounded-full border px-4 py-1.5 text-label-sm font-semibold transition-colors ${
                      isEmergency
                        ? "border-error-container bg-error-container text-on-error-container hover:opacity-90"
                        : "border-outline-variant/60 bg-surface text-on-surface-variant hover:bg-surface-container"
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          );
        }
        // action_proposal
        return (
          <div key={key} className="ml-10 self-start w-full max-w-[400px]">
            <ProposalCard
              proposal={block.proposal}
              confirmed={confirmed.has(key)}
              removing={removing.has(key)}
              dismissed={dismissed.has(key)}
              error={errors[key]}
              onConfirm={() => onConfirm(key, block.proposal)}
              onRemove={() => onRemove(key)}
              onDismiss={() => onDismiss(key)}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Chat-inline place recommendation card. Deliberately NOT tappable as a
 * whole — only the explicit "View" button is interactive, which opens
 * `PlaceCardModal` (rendered once at the page level). Adding/removing the
 * place from the itinerary happens inside that modal, not from a tap
 * anywhere on this card.
 */
function RichPlaceCard({
  card,
  added,
  error,
  onView,
}: {
  card: PlaceCard;
  added: boolean;
  error?: string;
  onView: () => void;
}) {
  return (
    <Card accent noPadding className="flex flex-col">
      <div className="relative h-40 bg-surface-container-high">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={card.image_url}
          alt={card.name}
          className="h-full w-full object-cover"
        />
        <div className="absolute right-3 top-3 flex items-center gap-1 rounded-lg bg-background/90 px-2 py-1 shadow-sm backdrop-blur-md">
          <Icon name="star" filled size={14} className="text-secondary-container" />
          <span className="text-label-sm text-on-surface">
            {card.rating.toFixed(1)}
          </span>
        </div>
        {added ? (
          <div className="absolute left-3 top-3 flex items-center gap-1 rounded-full bg-primary/95 px-2.5 py-1 text-label-sm font-semibold text-on-primary shadow-sm backdrop-blur-md">
            <Icon name="check_circle" filled size={14} />
            Added
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-3 p-4 pl-5">
        <div>
          <div className="mb-1 flex items-start justify-between gap-2">
            <h3 className="text-headline-sm text-on-surface">{card.name}</h3>
            {card.price_tier ? (
              <span className="shrink-0 rounded-full bg-surface-container px-2 py-0.5 text-label-sm text-on-surface-variant">
                {card.price_tier}
              </span>
            ) : null}
          </div>
          <p className="text-label-md text-on-surface-variant line-clamp-2">
            {card.description}
          </p>
        </div>
        <div className="mt-1 flex items-center gap-4 text-on-surface-variant">
          {card.duration_label ? (
            <span className="flex items-center gap-1.5">
              <Icon name="schedule" size={16} />
              <span className="text-label-sm">{card.duration_label}</span>
            </span>
          ) : null}
          {card.distance_label ? (
            <span className="flex items-center gap-1.5">
              <Icon name="directions_walk" size={16} />
              <span className="text-label-sm">{card.distance_label}</span>
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onView}
          className="mt-1 flex w-full items-center justify-center gap-2 rounded-xl border-[1.5px] border-primary py-3 text-label-md font-semibold text-primary transition-colors hover:bg-primary/5"
        >
          <Icon name="visibility" size={18} />
          View
        </button>
        {error ? <p className="text-label-sm text-error">{error}</p> : null}
      </div>
    </Card>
  );
}

/**
 * Detail modal for a chat `rich_card` place, opened via `RichPlaceCard`'s
 * "View" button. Add/Remove is the only place this card's itinerary
 * membership can be changed from — never a tap on the card itself.
 */
function PlaceCardModal({
  entry,
  onClose,
  added,
  removing,
  error,
  onAdd,
  onRemove,
}: {
  entry: { key: string; card: PlaceCard } | null;
  onClose: () => void;
  added: boolean;
  removing: boolean;
  error?: string;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const card = entry?.card ?? null;
  return (
    <BottomSheet open={entry !== null} onClose={onClose} title={card?.name}>
      {card ? (
        <div className="flex flex-col gap-4">
          <div className="relative h-48 w-full overflow-hidden rounded-xl bg-surface-container-high">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={card.image_url} alt={card.name} className="h-full w-full object-cover" />
            <div className="absolute right-3 top-3 flex items-center gap-1 rounded-lg bg-background/90 px-2 py-1 shadow-sm backdrop-blur-md">
              <Icon name="star" filled size={14} className="text-secondary-container" />
              <span className="text-label-sm text-on-surface">{card.rating.toFixed(1)}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-label-md text-on-surface-variant">
            <span>{card.category}</span>
            {card.price_tier ? (
              <>
                <span>&bull;</span>
                <span>{card.price_tier}</span>
              </>
            ) : null}
          </div>

          <p className="text-body-md text-on-surface-variant">{card.description}</p>

          {(card.duration_label || card.distance_label) ? (
            <div className="flex items-center gap-4 border-t border-outline-variant/30 pt-4 text-on-surface-variant">
              {card.duration_label ? (
                <span className="flex items-center gap-1.5">
                  <Icon name="schedule" size={18} className="text-primary" />
                  <span className="text-label-md">{card.duration_label}</span>
                </span>
              ) : null}
              {card.distance_label ? (
                <span className="flex items-center gap-1.5">
                  <Icon name="directions_walk" size={18} className="text-primary" />
                  <span className="text-label-md">{card.distance_label}</span>
                </span>
              ) : null}
            </div>
          ) : null}

          {error ? <p className="text-label-sm text-error">{error}</p> : null}

          {card.cta_label ? (
            <Button
              variant={added ? "danger" : "orange"}
              fullWidth
              leadingIcon={added ? "delete" : "add_circle"}
              onClick={added ? onRemove : onAdd}
              disabled={removing}
            >
              {added
                ? removing
                  ? "Removing…"
                  : "Remove from Itinerary"
                : removing
                  ? "Adding…"
                  : "Add to Itinerary"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </BottomSheet>
  );
}

function ProposalCard({
  proposal,
  confirmed,
  removing,
  dismissed,
  error,
  onConfirm,
  onRemove,
  onDismiss,
}: {
  proposal: ActionProposal;
  confirmed: boolean;
  removing: boolean;
  dismissed: boolean;
  error?: string;
  onConfirm: () => void;
  onRemove: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-xl border border-primary/10 bg-primary-fixed px-5 py-4 text-on-primary-fixed shadow-[0_2px_8px_rgba(3,22,50,0.06)]">
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background/50 text-primary">
            <Icon name={confirmed ? "event_available" : "event"} size={18} />
          </span>
          <div>
            <h4 className="mb-1 text-label-md font-semibold">Action Proposal</h4>
            <p className="text-label-md text-on-primary-fixed-variant">
              {proposal.summary}
            </p>
          </div>
        </div>

        {confirmed ? (
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-label-md font-semibold text-primary">
              <Icon name="check_circle" filled size={18} />
              Added to itinerary
            </span>
            <button
              type="button"
              onClick={onRemove}
              disabled={removing}
              className="flex items-center gap-1.5 rounded-xl border border-outline/30 px-3 py-1.5 text-label-sm font-medium text-on-primary-fixed transition-colors hover:bg-background/40 disabled:opacity-50"
            >
              <Icon name="delete" size={16} />
              {removing ? "Removing…" : "Remove"}
            </button>
          </div>
        ) : dismissed ? (
          <div className="flex items-center justify-end gap-1.5 text-label-md text-on-primary-fixed-variant">
            <Icon name="cancel" size={18} />
            Dismissed
          </div>
        ) : (
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-xl border border-outline/30 px-4 py-2 text-label-md font-medium text-on-primary-fixed transition-colors hover:bg-background/40"
            >
              {proposal.dismiss_label ?? "Dismiss"}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-xl bg-primary px-4 py-2 text-label-md font-medium text-on-primary shadow-sm transition-opacity hover:opacity-90"
            >
              {proposal.confirm_label ?? "Confirm"}
            </button>
          </div>
        )}
        {error ? <p className="text-right text-label-sm text-error">{error}</p> : null}
      </div>
    </div>
  );
}
