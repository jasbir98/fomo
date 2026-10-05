"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { addMessage, clearMessages, listMessages } from "@/lib/db";
import { ASK_FOMO_PROMPTS, type AiReplyBlock, type ChatItem, type ChatPlace } from "@/lib/fomo-ai";
import { suggestedQuestionsFor, type ChatSeed } from "@/lib/chat-seed";
import type { ChatMessage } from "@/lib/types";
import { track } from "@/lib/analytics/track";

/**
 * What a user turn carries about the card it was asked from, once attached
 * to a message (as opposed to `ChatSeed`, which is the page's own URL-driven
 * "what was I opened for" state — see the seed-lifecycle comment above
 * `pendingSeed` below). Deliberately a subset of `ChatSeed`: no `returnTo`,
 * which is a navigation detail of the page visit, not a fact about the item.
 */
export interface SeedAttachment {
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
 * `signin` marks a local-only assistant turn (limit hit, session expired) that
 * carries a sign-in card for `question`; it lives in sessionStorage with the
 * rest of a signed-out chat and is never written to `chat_messages`.
 */
export type UiMessage =
  | { id: string; role: "user"; text: string; seed?: SeedAttachment }
  | { id: string; role: "assistant"; blocks: AiReplyBlock[]; signin?: { question: string; expired?: boolean } };

/** The assistant half of `UiMessage`. */
export type UiAssistantMessage = Extract<UiMessage, { role: "assistant" }>;

/** A signed-out visitor's free questions left today (from /api/chat/quota and the chat stream's `quota` event). */
export interface Quota {
  remaining: number;
  limit: number;
}

/** null when signed in, on any failure, or if the route isn't there: the quota line just doesn't show. */
async function loadQuota(): Promise<Quota | null> {
  try {
    const res = await fetch("/api/chat/quota", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { signedIn?: boolean; remaining?: number; limit?: number };
    if (data.signedIn !== false || typeof data.remaining !== "number" || typeof data.limit !== "number") return null;
    return { remaining: data.remaining, limit: data.limit };
  } catch {
    return null;
  }
}

/** Shown when a reply stream ends early; the question is put back in the composer alongside it. */
const DROPPED_NOTE = "The connection dropped before I finished. Your question's still in the box, just hit send again.";

/** Only the most recent turns are sent as API history — keeps each request's token cost bounded. */
const MAX_HISTORY_MESSAGES = 12;

/** `chat_messages.mode` value for new turns. Chat has one mode now; older rows carry trip-era modes and render the same. */
const CHAT_MODE = "ask";

/** Signed-out visitors keep their conversation here (per tab, gone when it closes) instead of in `chat_messages`. */
const ANON_CHAT_KEY = "fomo:anon-chat";
const MAX_ANON_MESSAGES = 40;

function readAnonChat(): UiMessage[] {
  try {
    const raw = sessionStorage.getItem(ANON_CHAT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m): m is UiMessage => {
      if (!m || typeof m !== "object") return false;
      const v = m as Record<string, unknown>;
      if (typeof v.id !== "string") return false;
      if (v.role === "user") return typeof v.text === "string";
      return v.role === "assistant" && Array.isArray(v.blocks);
    });
  } catch {
    return [];
  }
}

function writeAnonChat(messages: UiMessage[]) {
  try {
    if (messages.length === 0) sessionStorage.removeItem(ANON_CHAT_KEY);
    else sessionStorage.setItem(ANON_CHAT_KEY, JSON.stringify(messages.slice(-MAX_ANON_MESSAGES)));
  } catch {
    // Private window / blocked storage: the chat just doesn't survive a reload.
  }
}

/** Flatten an assistant turn's blocks to plain text for the API history. */
function blocksToText(blocks: AiReplyBlock[]): string {
  return blocks
    .map((b) => {
      if (b.kind === "text") return b.text;
      if (b.kind === "items") return `[Showed: ${b.items.map((item) => item.title).join(", ")}]`;
      if (b.kind === "places") return `[Places shown: ${b.places.map((p) => p.name).join(", ")}]`;
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

/** What one assistant reply showed: its catalogue items and Google places, across all of its blocks. */
export interface ReplyResults {
  replyId: string;
  items: ChatItem[];
  places: ChatPlace[];
}

/** The items/places an assistant turn showed, or null when it showed none. */
export function replyResults(message: UiAssistantMessage): ReplyResults | null {
  const items: ChatItem[] = [];
  const places: ChatPlace[] = [];
  for (const block of message.blocks) {
    if (block.kind === "items") items.push(...block.items);
    else if (block.kind === "places") places.push(...block.places);
  }
  if (items.length === 0 && places.length === 0) return null;
  return { replyId: message.id, items, places };
}

/** Results of the most recent assistant turn that showed any items or places; null when none has. */
export function latestReplyResults(messages: UiMessage[]): ReplyResults | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const results = replyResults(m);
    if (results) return results;
  }
  return null;
}

export interface UseFomoChatOptions {
  /**
   * Ask Fomo seed — set when the chat was opened from a card's "Ask Fomo"
   * action rather than the plain FAB. Drives the pending seed context card
   * (see `pendingSeed`), the suggested-question chips, and the system
   * prompt's context. `ChatSeed` fits (its `returnTo` is ignored here).
   */
  seed?: Omit<ChatSeed, "returnTo"> | null;
  /** Initial composer text (e.g. `?q=` prefill) — read on first mount only. */
  initialInput?: string;
  /**
   * When set, send `question` once the history has loaded (the `?q=…&send=1`
   * link). `onStart` runs first, just before sending — the page uses it to drop
   * the params from the URL so a refresh doesn't ask it again. Fires once per
   * mount even if the question is empty (then only `onStart` runs).
   */
  autoSend?: { question?: string; onStart?: () => void } | null;
}

export interface UseFomoChat {
  messages: UiMessage[];
  /** Composer text. */
  input: string;
  setInput: (value: string) => void;
  /** A reply is in flight. */
  sending: boolean;
  /** Server progress note for the in-flight reply, e.g. "Checking Google Maps…". */
  pendingStatus: string | null;
  /** History has finished loading (successfully or not). */
  ready: boolean;
  /** null until the mount-time session check finishes. */
  signedIn: boolean | null;
  /** Signed-out visitors only: free questions left today. Null until the fetch lands (or when signed in). */
  quota: Quota | null;
  loadFailed: boolean;
  /** Out of free questions: the composer is switched off until they sign in. */
  exhausted: boolean;
  /** The seed's context card is still waiting for the first send of this visit. */
  pendingSeed: SeedAttachment | null;
  /** Suggested-question chips: the seed type's questions, else the starter prompts. */
  suggestions: string[];
  /** Send `text` as a new turn (no-op when empty, busy, or the session check hasn't finished). */
  send: (text: string) => Promise<void>;
  clearDialogOpen: boolean;
  clearing: boolean;
  /** Open the "Clear chat?" confirmation. */
  requestClear: () => void;
  /** Dismiss the confirmation without clearing. */
  cancelClear: () => void;
  /** Clear this user's chat history from the database and the client, then close the confirmation. */
  clear: () => Promise<void>;
}

export function useFomoChat({ seed = null, initialInput = "", autoSend = null }: UseFomoChatOptions = {}): UseFomoChat {
  const db = supabaseBrowserAuth();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  // Plain-text prefill (`?q=` from Book Early / Free Any Time's own "Ask
  // Fomo" buttons) — fills the composer without sending, on first mount only.
  const [input, setInput] = useState(() => initialInput);
  const [sending, setSending] = useState(false);
  /** Server progress note for the in-flight reply, e.g. "Checking Google Maps…". */
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  /** Text streamed so far for the in-flight reply; read by the error path so a dropped stream keeps it. */
  const streamedSoFar = useRef("");
  const [ready, setReady] = useState(false);
  // null until the session check on mount finishes; false = signed out (chat
  // lives in sessionStorage, nothing touches `chat_messages`).
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  // Signed-out visitors only: free questions left today. Null until the quota fetch lands (or when signed in).
  const [quota, setQuota] = useState<Quota | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  // `?q=…&send=1` auto-sends once; the ref stops React strict mode's double effect run sending it twice.
  const didAutoSend = useRef(false);

  // On mount: work out who this is, then load this user's chat history
  // (user-scoped, see lib/db/chat.ts) or, signed out, the sessionStorage copy.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const {
          data: { session },
        } = await db.auth.getSession();
        if (cancelled) return;
        if (session) {
          setSignedIn(true);
          const history = await listMessages(db);
          if (!cancelled) setMessages(history.map(parseMessage));
        } else {
          setSignedIn(false);
          setMessages(readAnonChat());
        }
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
    if (signedIn !== false) return;
    let cancelled = false;
    void loadQuota().then((q) => {
      if (!cancelled && q) setQuota(q);
    });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  // Signed-out chats are mirrored to sessionStorage once a reply has settled.
  useEffect(() => {
    if (!ready || signedIn !== false || sending) return;
    writeAnonChat(messages);
  }, [messages, ready, signedIn, sending]);

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
    // signedIn is null until the mount-time session check is done; sending before then could misfile the turn.
    if (!trimmed || sending || signedIn === null) return;
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
    const isSignedIn = signedIn === true;
    let userTurnId = createPendingId();

    const updateProvisional = (blocks: AiReplyBlock[]) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === provisionalId && m.role === "assistant" ? { ...m, blocks } : m))
      );
    };
    // Replaces the provisional reply with `text` and a sign-in card that re-asks this question afterwards.
    const showSignin = (text: string, expired = false) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === provisionalId && m.role === "assistant"
            ? { ...m, blocks: [{ kind: "text", text }], signin: { question: trimmed, expired } }
            : m
        )
      );
    };
    // Only signed-out visitors have a free-question allowance; the server refunds it whenever the failure was ours.
    const notCounted = isSignedIn ? "" : " It didn't count towards your free questions.";
    // Set on failure paths, so the quota line is re-read from the server afterwards.
    let failed = false;

    try {
      // Persist + append the user turn, with a provisional assistant turn
      // that grows as text streams in.
      const userContent: { text: string; seed?: SeedAttachment } = attachSeed
        ? { text: trimmed, seed: attachSeed }
        : { text: trimmed };
      if (isSignedIn) {
        const userRow = await addMessage(db, { role: "user", mode: CHAT_MODE, content: userContent });
        userTurnId = userRow.id;
      }
      setMessages((prev) => [
        ...prev,
        { id: userTurnId, role: "user", text: trimmed, seed: attachSeed ?? undefined },
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

      // Rate limited. Out of free questions (signed out): keep the question in
      // the chat and offer sign-in, which re-asks it. Otherwise show the
      // server's "try again in N minutes" message and keep the question in the
      // composer so it can be resent later.
      if (res.status === 429) {
        let message = "You've hit the limit for now. Try again in a few minutes.";
        let needsSignin = false;
        let limit: number | null = null;
        try {
          const data = (await res.json()) as { message?: string; signin?: boolean; limit?: number };
          if (typeof data?.message === "string") message = data.message;
          needsSignin = data?.signin === true;
          if (typeof data?.limit === "number") limit = data.limit;
        } catch {
          // Keep the fallback message above.
        }
        if (needsSignin) {
          const total = limit ?? quota?.limit ?? 3;
          setQuota({ remaining: 0, limit: total });
          showSignin(
            `You've used your ${total} free questions for today. Sign in with your email (no password needed) and I'll answer this one straight away.`,
          );
        } else {
          setInput(trimmed);
          updateProvisional([{ kind: "text", text: message }]);
        }
        return;
      }

      if (res.status === 401) {
        setInput(trimmed);
        showSignin("Your session ran out. Sign in again and I'll pick up where we left off.", true);
        return;
      }

      if (!res.ok || !res.body) {
        failed = true;
        setInput(trimmed);
        // A 400 carries its own reason (e.g. message too long); anything else is on our side.
        let text = `Something went wrong on our side. Your question's still in the box below, just hit send again.${notCounted}`;
        if (res.status === 400) {
          try {
            const data = (await res.json()) as { message?: string };
            if (typeof data?.message === "string" && data.message) text = data.message;
          } catch {
            // Keep the generic message.
          }
        }
        updateProvisional([{ kind: "text", text }]);
        return;
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
            | { type: "error"; message: string }
            | { type: "status"; text: string }
            | { type: "quota"; remaining: number; limit: number };
          if (event.type === "quota") {
            setQuota({ remaining: event.remaining, limit: event.limit });
          } else if (event.type === "status") {
            setPendingStatus(event.text);
          } else if (event.type === "text_delta") {
            streamedText += event.text;
            streamedSoFar.current = streamedText;
            updateProvisional([{ kind: "text", text: streamedText }]);
          } else if (event.type === "done") {
            finalBlocks = event.blocks;
          } else if (event.type === "error") {
            errored = true;
            failed = true;
            setInput(trimmed);
            updateProvisional([{ kind: "text", text: `${event.message}${notCounted}` }]);
          }
        }
      }

      if (finalBlocks && !errored) {
        // Persist the assembled assistant turn, then swap the provisional
        // message for the persisted row (real id + final blocks). Signed-out
        // turns aren't persisted server-side; they just take the final blocks.
        const blocks = finalBlocks;
        if (isSignedIn) {
          const aiRow = await addMessage(db, {
            role: "assistant",
            mode: CHAT_MODE,
            content: { blocks },
          });
          setMessages((prev) =>
            prev.map((m) =>
              m.id === provisionalId && m.role === "assistant" ? { id: aiRow.id, role: "assistant", blocks } : m
            )
          );
        } else {
          updateProvisional(blocks);
        }
      } else if (!errored) {
        // Stream ended with neither a reply nor an error (e.g. the server timed out).
        failed = true;
        setInput(trimmed);
        updateProvisional([{ kind: "text", text: DROPPED_NOTE }]);
      }
    } catch (err) {
      console.error("[fomo] send failed", err);
      // Keep whatever reply already streamed in; only the unfinished tail is lost.
      failed = true;
      updateProvisional(
        streamedSoFar.current
          ? [{ kind: "text", text: streamedSoFar.current }, { kind: "text", text: DROPPED_NOTE }]
          : [{ kind: "text", text: DROPPED_NOTE }]
      );
      setInput(trimmed);
    } finally {
      if (failed && !isSignedIn) void loadQuota().then((q) => q && setQuota(q));
      streamedSoFar.current = "";
      setPendingStatus(null);
      setSending(false);
    }
  }

  /** Clear this user's chat history from the database and the client. */
  async function clear() {
    setClearing(true);
    try {
      if (signedIn) await clearMessages(db);
      setMessages([]);
      setClearDialogOpen(false);
    } catch (err) {
      console.error("[fomo] clear chat failed", err);
    } finally {
      setClearing(false);
    }
  }

  // `?q=…&send=1` (e.g. a shared/landing link) sends that question once, then
  // drops the params (the caller's `autoSend.onStart`) so a refresh doesn't
  // ask it again. Plain `?q=` only prefills the composer (see `input`'s
  // initial value).
  useEffect(() => {
    if (!ready || didAutoSend.current) return;
    if (!autoSend) return;
    // Deferred so it isn't a synchronous setState in the effect body. The ref
    // is only set when the timer fires, so strict mode's mount/unmount/mount
    // (which clears the first timer) still sends exactly once.
    const timer = setTimeout(() => {
      if (didAutoSend.current) return;
      didAutoSend.current = true;
      autoSend.onStart?.();
      if (autoSend.question) void send(autoSend.question);
    }, 0);
    return () => clearTimeout(timer);
    // `send` is a fresh closure each render; this must fire once when history is ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const suggestions = seed ? suggestedQuestionsFor(seed.type) : ASK_FOMO_PROMPTS;
  // Out of free questions: the composer is switched off until they sign in.
  const exhausted = signedIn === false && quota?.remaining === 0;

  return {
    messages,
    input,
    setInput,
    sending,
    pendingStatus,
    ready,
    signedIn,
    quota,
    loadFailed,
    exhausted,
    pendingSeed,
    suggestions,
    send,
    clearDialogOpen,
    clearing,
    requestClear: () => setClearDialogOpen(true),
    cancelClear: () => setClearDialogOpen(false),
    clear,
  };
}
