"use client";

import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ConfirmDialog, Icon, SmartImage } from "@/components/ui";
import { FomoFace, type FomoMood } from "@/components/onboarding/Characters";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { addMessage, clearMessages, listMessages } from "@/lib/db";
import { ASK_FOMO_PROMPTS, type AiReplyBlock, type ChatItem } from "@/lib/fomo-ai";
import { hrefForSeed, readChatSeed, suggestedQuestionsFor, type ChatSeed } from "@/lib/chat-seed";
import type { ChatMessage } from "@/lib/types";
import { track } from "@/lib/analytics/track";

/**
 * Minimal inline markdown for assistant/user chat text — no markdown library
 * in this project. Handles `**bold**` and `*italic*` only, splitting on a
 * single regex pass. Bold is matched before italic in the alternation so
 * `**x**` never gets mis-split into two italic halves.
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

/** Three-dot "thinking" indicator shown while a reply is streaming but no text has arrived yet. */
function ThinkingDots() {
  return (
    <div
      role="status"
      aria-label="Fomo is thinking"
      className="flex items-center gap-1 rounded-xl rounded-tl-sm border border-outline-variant/50 bg-surface px-5 py-4 shadow-[0_1px_3px_rgba(3,22,50,0.05)]"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 animate-bounce rounded-full bg-outline motion-reduce:animate-none"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}

/**
 * What a user turn carries about the card it was asked from, once attached
 * to a message (as opposed to `ChatSeed`, which is the page's own URL-driven
 * "what was I opened for" state — see the seed-lifecycle comment above
 * `pendingSeed` below). Deliberately a subset of `ChatSeed`: no `returnTo`,
 * which is a navigation detail of the page visit, not a fact about the item.
 */
interface SeedAttachment {
  type: ChatSeed["type"];
  id: string;
  name: string;
  city?: string;
  lat?: number;
  lng?: number;
}

function isSeedAttachment(v: unknown): v is SeedAttachment {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.type === "string" && typeof s.id === "string" && typeof s.name === "string";
}

/**
 * UI-side message model. Parsed from `chat_messages.content` (jsonb):
 *   user turn      → content = { text: string, seed?: SeedAttachment }
 *   assistant turn → content = { blocks: AiReplyBlock[] }
 * `seed` is only ever present on the first user turn of a seeded visit (see
 * `pendingSeed`); older rows simply don't have it and render unchanged.
 */
type UiMessage =
  | { id: string; role: "user"; text: string; seed?: SeedAttachment }
  | { id: string; role: "assistant"; blocks: AiReplyBlock[] };

/** Only the most recent turns are sent as API history — keeps each request's token cost bounded. */
const MAX_HISTORY_MESSAGES = 12;

/** `chat_messages.mode` value for new turns. Chat has one mode now; older rows carry trip-era modes and render the same. */
const CHAT_MODE = "ask";

/** Flatten an assistant turn's blocks to plain text for the API history. */
function blocksToText(blocks: AiReplyBlock[]): string {
  return blocks
    .map((b) => {
      if (b.kind === "text") return b.text;
      if (b.kind === "items") return `[Showed: ${b.items.map((item) => item.title).join(", ")}]`;
      if (b.kind === "quick_replies") return `[Quick replies offered: ${b.quick_replies.options.join(", ")}]`;
      if (b.kind === "rich_card") return `[Suggested place: ${b.card.name}]`;
      return `[Suggested: ${b.proposal.title}]`;
    })
    .filter(Boolean)
    .join("\n");
}

function parseMessage(m: ChatMessage): UiMessage {
  if (m.role === "user") {
    const c = (m.content ?? {}) as { text?: string; seed?: unknown };
    const seed = isSeedAttachment(c.seed) ? c.seed : undefined;
    return { id: m.id, role: "user", text: c.text ?? "", seed };
  }
  const c = (m.content ?? {}) as { blocks?: AiReplyBlock[] };
  return { id: m.id, role: "assistant", blocks: c.blocks ?? [] };
}

/** The seed carried by the most recent user turn, if any — used to decide whether a seeded visit's context card is still "pending" (see `pendingSeed`). */
function lastUserSeed(messages: UiMessage[]): SeedAttachment | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return m.seed;
  }
  return undefined;
}

function createPendingId(): string {
  if (globalThis.crypto?.randomUUID) {
    return `pending-${globalThis.crypto.randomUUID()}`;
  }
  return `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const SEED_ICON: Partial<Record<ChatSeed["type"], string>> = {
  happening: "sell",
  event: "event",
};

export default function FomoChatPage() {
  return (
    <Suspense fallback={null}>
      <FomoChatPageInner />
    </Suspense>
  );
}

function FomoChatPageInner() {
  const db = supabaseBrowserAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Ask Fomo seed — set when this page was opened from a card's "Ask Fomo"
  // action rather than the plain FAB. Drives the inline seed context card
  // (see `pendingSeed`), the suggested-question chips, and the system
  // prompt's context.
  const seed: ChatSeed | null = useMemo(() => readChatSeed(searchParams), [searchParams]);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  // Plain-text prefill (`?q=` from Book Early / Free Any Time's own "Ask
  // Fomo" buttons) — fills the composer without sending, on first mount only.
  const [input, setInput] = useState(() => searchParams.get("q") ?? "");
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  // First scroll after history loads jumps straight to bottom (no visible
  // scroll animation) so a seeded visit opens on the seed card + composer,
  // not mid-animation from wherever the top of a long history sits. Every
  // scroll after that (sends, quick replies) is the usual smooth one.
  const didInitialScroll = useRef(false);

  // On mount: load this user's chat history (user-scoped, see lib/db/chat.ts).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const history = await listMessages(db);
        if (!cancelled) setMessages(history.map(parseMessage));
      } catch (err) {
        console.error("[fomo] load failed", err);
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db]);

  useEffect(() => {
    if (!ready) return;
    const behavior: ScrollBehavior = didInitialScroll.current ? "smooth" : "auto";
    endRef.current?.scrollIntoView({ behavior, block: "end" });
    didInitialScroll.current = true;
  }, [messages.length, ready]);

  // Seed lifecycle for this visit: `seed` (from the URL) is "pending" — shown
  // as an inline context card at the end of the message list — until the
  // user's first send during this visit attaches it to that user message
  // (see `send`, below). Once attached it lives in history on that message
  // instead, so this recomputes to null the moment `messages` gains that
  // user turn — including on reload of the same seeded URL, where the seed
  // is already attached to the last user message and no duplicate shows.
  const pendingSeed: SeedAttachment | null = useMemo(() => {
    if (!seed) return null;
    const last = lastUserSeed(messages);
    if (last && last.type === seed.type && last.id === seed.id) return null;
    return {
      type: seed.type,
      id: seed.id,
      name: seed.name,
      ...(seed.city ? { city: seed.city } : {}),
      ...(seed.coords ? { lat: seed.coords.lat, lng: seed.coords.lng } : {}),
    };
  }, [seed, messages]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    track("chat_message_sent", { length: trimmed.length });
    setSending(true);
    setInput("");

    // A seeded user turn is sent to the model as `[About: <name>] <text>` so
    // later turns in the same history keep the context once the pending/
    // attached seed card is no longer literally in front of it.
    const history = messages.slice(-MAX_HISTORY_MESSAGES).map((m) =>
      m.role === "user"
        ? { role: "user" as const, text: m.seed ? `[About: ${m.seed.name}] ${m.text}` : m.text }
        : { role: "assistant" as const, text: blocksToText(m.blocks) }
    );

    // Attach the seed to this send only if it's still pending (first send of
    // the visit) — later sends in the same visit already have it on an
    // earlier message, so don't repeat it.
    const attachSeed = pendingSeed;

    const provisionalId = createPendingId();

    const updateProvisional = (blocks: AiReplyBlock[]) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === provisionalId && m.role === "assistant" ? { ...m, blocks } : m))
      );
    };

    try {
      // Persist + append the user turn, with a provisional assistant turn
      // that grows as text streams in.
      const userContent: { text: string; seed?: SeedAttachment } = attachSeed
        ? { text: trimmed, seed: attachSeed }
        : { text: trimmed };
      const userRow = await addMessage(db, { role: "user", mode: CHAT_MODE, content: userContent });
      setMessages((prev) => [
        ...prev,
        { id: userRow.id, role: "user", text: trimmed, seed: attachSeed ?? undefined },
        { id: provisionalId, role: "assistant", blocks: [{ kind: "text", text: "" }] },
      ]);

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          history,
          userText: trimmed,
          seed: seed ? { type: seed.type, name: seed.name, city: seed.city ?? null } : null,
        }),
      });

      // Rate limited — show the server's "try again in N minutes" message and
      // keep the question in the composer so it can be resent later.
      if (res.status === 429) {
        let message = "You've hit the limit for now — try again in a few minutes.";
        try {
          const data = (await res.json()) as { message?: string };
          if (typeof data?.message === "string") message = data.message;
        } catch {
          // Keep the fallback message above.
        }
        updateProvisional([{ kind: "text", text: message }]);
        setInput(trimmed);
        return;
      }

      if (!res.ok || !res.body) {
        throw new Error(`chat request failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamedText = "";
      let finalBlocks: AiReplyBlock[] | null = null;
      let errored = false;

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
        // Persist the assembled assistant turn, then swap the provisional
        // message for the persisted row (real id + final blocks).
        const blocks = finalBlocks;
        const aiRow = await addMessage(db, { role: "assistant", mode: CHAT_MODE, content: { blocks } });
        setMessages((prev) =>
          prev.map((m) =>
            m.id === provisionalId && m.role === "assistant" ? { id: aiRow.id, role: "assistant", blocks } : m
          )
        );
      } else if (!errored) {
        updateProvisional([{ kind: "text", text: "Fomo didn't finish that reply. Please try again." }]);
      }
    } catch (err) {
      console.error("[fomo] send failed", err);
      updateProvisional([{ kind: "text", text: "Fomo hit a snag. Please try again in a moment." }]);
      setInput(trimmed);
    } finally {
      setSending(false);
    }
  }

  /** Clear this user's chat history from the database and the client. */
  async function handleClearChat() {
    setClearing(true);
    try {
      await clearMessages(db);
      setMessages([]);
      setClearDialogOpen(false);
    } catch (err) {
      console.error("[fomo] clear chat failed", err);
    } finally {
      setClearing(false);
    }
  }

  const suggestions = seed ? suggestedQuestionsFor(seed.type) : ASK_FOMO_PROMPTS;
  const empty = ready && messages.length === 0;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 flex items-center justify-between gap-2 bg-background/90 px-5 min-h-[56px] pt-safe backdrop-blur-sm">
        <div className="flex items-center gap-2">
          {seed ? (
            <button
              type="button"
              aria-label="Back"
              onClick={() => router.push(seed.returnTo)}
              className="flex h-10 w-10 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-low"
            >
              <Icon name="arrow_back" />
            </button>
          ) : (
            <FomoFace mood={sending ? "hmm" : "grin"} className="h-8 w-8 drop-shadow-sm" />
          )}
          <h1 className="text-headline-sm text-primary">Ask Fomo</h1>
        </div>
        {messages.length > 0 ? (
          <button
            type="button"
            aria-label="Clear chat"
            onClick={() => setClearDialogOpen(true)}
            className="flex h-10 w-10 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-low"
          >
            <Icon name="delete_outline" />
          </button>
        ) : null}
      </header>

      <main className="flex flex-1 flex-col gap-6 px-5 pt-4 pb-[220px]">
        {loadFailed ? (
          <p className="rounded-lg bg-surface-container px-3 py-2 text-label-sm text-on-surface-variant">
            Couldn&apos;t load your earlier messages. New ones will still send.
          </p>
        ) : null}

        {empty ? (
          <div className="mt-4 flex flex-col items-center gap-3 text-center">
            <FomoSpot mood={seed ? "hmm" : "grin"} pose="wave" className="h-28 w-28" />
            <p className="text-body-lg text-on-surface">
              {seed ? `Ask me anything about ${seed.name}.` : "What are you in the mood for?"}
            </p>
            <p className="max-w-[300px] text-body-md text-on-surface-variant">
              {seed
                ? "Try one of these, or type your own."
                : "I know what's on in Edinburgh right now — deals, free things and this week's events."}
            </p>
          </div>
        ) : null}

        {messages.map((m, mi) => {
          if (m.role === "user") return <UserBubble key={m.id} text={m.text} seed={m.seed} />;
          const isProvisional =
            sending &&
            mi === messages.length - 1 &&
            m.blocks.length === 1 &&
            m.blocks[0].kind === "text" &&
            m.blocks[0].text === "";
          if (isProvisional) {
            return (
              <div key={m.id} className="flex max-w-[90%] items-end gap-2 self-start">
                <FomoAvatar mood="hmm" />
                <ThinkingDots />
              </div>
            );
          }
          return (
            <AssistantTurn key={m.id} messageId={m.id} blocks={m.blocks} onQuickReply={(option) => void send(option)} />
          );
        })}

        {/* Seed context card — shown inline at the end of the conversation (not pinned above it) until the
            first send of this visit attaches it to that user message; see `pendingSeed`. */}
        {pendingSeed ? (
          <div className="mx-auto flex w-full max-w-[320px] flex-col items-center gap-1.5">
            <p className="text-label-sm font-medium text-on-surface-variant">Asking about</p>
            <SeedCard seed={pendingSeed} className="w-full" />
          </div>
        ) : null}

        <div ref={endRef} />
      </main>

      {/* Composer: suggested prompts + input bar, fixed above the bottom nav (and its safe-area inset). */}
      <div className="fixed bottom-[calc(64px+env(safe-area-inset-bottom))] left-1/2 z-40 w-full max-w-[480px] -translate-x-1/2 bg-gradient-to-t from-background via-background to-transparent px-5 pb-3 pt-6">
        {suggestions.length > 0 ? (
          <div className="no-scrollbar mb-2 flex gap-2 overflow-x-auto">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void send(s)}
                disabled={sending}
                className="whitespace-nowrap rounded-full border border-outline-variant/60 bg-surface px-4 py-2 text-label-sm font-semibold text-on-surface-variant transition-colors hover:bg-surface-container disabled:opacity-40"
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}

        <div className="flex items-end gap-2 rounded-2xl border border-outline-variant/60 bg-surface p-2 shadow-[0_2px_12px_rgba(3,22,50,0.06)] focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
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
            aria-label="Message Fomo"
            placeholder="Ask about deals, free things, what's on…"
            className="max-h-[120px] min-h-[44px] flex-1 resize-none border-none bg-transparent p-2 text-body-md text-on-surface outline-none placeholder:text-outline focus:ring-0"
          />
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
    </div>
  );
}

/** Fomo's face beside its replies; "hmm" while a reply is still coming. */
function FomoAvatar({ mood = "grin" }: { mood?: FomoMood }) {
  return <FomoFace mood={mood} className="mb-1 h-8 w-8 shrink-0 drop-shadow-sm" />;
}

function UserBubble({ text, seed }: { text: string; seed?: SeedAttachment }) {
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1.5 self-end">
      {/* Compact attachment chip for the item this turn was asked about — only on the turn that carries it (see `pendingSeed`/`send`). */}
      {seed ? <SeedCard seed={seed} compact className="w-full max-w-[220px]" /> : null}
      <div className="rounded-xl rounded-tr-sm bg-primary px-5 py-3 text-on-primary shadow-sm">
        {/* ph-mask: PostHog session replay masks text inside this class by
            default (maskTextClass, posthog-js) — a user's own chat message
            is free-text and must never render as plain text in a replay.
            See instrumentation-client.ts's session_recording doc comment. */}
        <p className="ph-mask whitespace-pre-wrap text-body-md">{renderInlineMarkdown(text)}</p>
      </div>
    </div>
  );
}

/**
 * The "what is this conversation about" card — used both as the pending
 * context divider (full size, centered) and as the compact chip attached
 * above a user bubble once the seed has been sent (see `UserBubble`). Tap
 * target is the item's own detail page when `hrefForSeed` can derive one
 * reliably for this type; otherwise it's inert (no href to guess at).
 */
function SeedCard({
  seed,
  compact = false,
  className = "",
}: {
  seed: SeedAttachment;
  compact?: boolean;
  className?: string;
}) {
  const href = hrefForSeed(seed);
  const content = (
    <div
      className={`flex items-center gap-2.5 rounded-xl border border-outline-variant/60 bg-surface-container-lowest ${compact ? "p-2" : "p-2.5"} ${className}`}
    >
      <div
        className={`flex shrink-0 items-center justify-center rounded-lg bg-primary-fixed text-primary ${compact ? "h-7 w-7" : "h-9 w-9"}`}
      >
        <Icon name={SEED_ICON[seed.type] ?? "location_on"} size={compact ? 15 : 18} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-label-md font-bold text-primary">{seed.name}</p>
        {seed.city ? <p className="truncate text-label-sm text-on-surface-variant">{seed.city}</p> : null}
      </div>
    </div>
  );
  if (!href) return content;
  return (
    <Link href={href} className="block transition-opacity hover:opacity-80">
      {content}
    </Link>
  );
}

function AssistantTurn({
  messageId,
  blocks,
  onQuickReply,
}: {
  messageId: string;
  blocks: AiReplyBlock[];
  onQuickReply: (option: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, i) => {
        const key = `${messageId}:${i}`;
        if (block.kind === "text") {
          return (
            <div key={key} className="flex max-w-[90%] items-end gap-2 self-start">
              <FomoAvatar />
              <div className="rounded-xl rounded-tl-sm border border-outline-variant/50 bg-surface px-5 py-4 text-on-surface shadow-[0_1px_3px_rgba(3,22,50,0.05)]">
                {/* ph-mask: see UserBubble's matching comment above — the
                    assistant's reply text is generated from (and can quote)
                    the user's own message, so it's masked the same way. */}
                <p className="ph-mask whitespace-pre-wrap text-body-md">{renderInlineMarkdown(block.text)}</p>
              </div>
            </div>
          );
        }
        if (block.kind === "items") {
          return (
            <div key={key} className="ml-10 flex max-w-[400px] flex-col gap-2 self-stretch">
              {block.reason ? <p className="px-1 text-label-sm italic text-on-surface-variant">{block.reason}</p> : null}
              {block.items.map((item) => (
                <ChatItemCard key={`${item.kind}:${item.id}`} item={item} />
              ))}
            </div>
          );
        }
        if (block.kind === "quick_replies") {
          return (
            <div key={key} className="ml-10 flex w-full max-w-[400px] flex-col gap-1.5 self-start">
              <p className="px-1 text-label-sm font-medium text-on-surface-variant">
                {block.quick_replies.prompt ?? "Try one of these:"}
              </p>
              <div className="flex flex-wrap gap-2">
                {block.quick_replies.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onQuickReply(option)}
                    className="whitespace-nowrap rounded-full border border-outline-variant/60 bg-surface px-4 py-2 text-label-sm font-semibold text-on-surface-variant transition-colors hover:bg-surface-container"
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          );
        }
        if (block.kind === "rich_card") {
          // Trip-era history: show the name and text only — the photo and
          // rating on these cards were model-generated, not real.
          return (
            <div
              key={key}
              className="ml-10 max-w-[340px] self-start rounded-xl border border-outline-variant/50 bg-surface-container-lowest px-4 py-3"
            >
              <p className="text-label-md font-bold text-on-surface">{block.card.name}</p>
              {block.card.description ? (
                <p className="mt-0.5 line-clamp-2 text-label-sm text-on-surface-variant">{block.card.description}</p>
              ) : null}
            </div>
          );
        }
        // Trip-era itinerary proposals have nothing to act on any more.
        return null;
      })}
    </div>
  );
}

/** A real catalogue item the reply pointed at — links to its own page. */
function ChatItemCard({ item }: { item: ChatItem }) {
  return (
    <Link
      href={item.href}
      className="flex items-center gap-3 rounded-xl border border-outline-variant/50 bg-surface-container-lowest p-2.5 shadow-[0_1px_3px_rgba(3,22,50,0.05)] transition-colors hover:bg-surface-container-low"
    >
      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-surface-container">
        <SmartImage src={item.image_url} alt="" width={56} height={56} className="h-full w-full object-cover" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-label-md font-bold text-on-surface">{item.title}</p>
        {item.subtitle ? <p className="truncate text-label-sm text-on-surface-variant">{item.subtitle}</p> : null}
      </div>
      {item.badge ? (
        <span className="shrink-0 rounded-full bg-surface-container px-2.5 py-1 text-label-sm font-extrabold text-primary">
          {item.badge}
        </span>
      ) : null}
      <Icon name="chevron_right" size={18} className="shrink-0 text-on-surface-variant" />
    </Link>
  );
}
