"use client";

import { Fragment, useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { CITY } from "@/lib/city";
import type { SeedAttachment, UiAssistantMessage, UiMessage } from "@/lib/fomo-chat/useFomoChat";
import { AssistantTurn } from "./AssistantTurn";
import { FomoAvatar, ThinkingDots, UserBubble } from "./ChatBubbles";
import { SeedCard } from "./SeedCard";
import { SigninCard } from "./SigninCard";

export interface ChatThreadProps {
  messages: UiMessage[];
  /** History has finished loading; gates the empty-state hero and the scroll-to-end. */
  ready: boolean;
  /** A reply is in flight (the last assistant turn shows thinking dots until text arrives). */
  sending: boolean;
  /** Server progress note for the in-flight reply, shown beside the thinking dots. */
  pendingStatus: string | null;
  /** Seed context card still waiting for the first send of this visit. */
  pendingSeed: SeedAttachment | null;
  /** The visit's seed, if any — only its name is used (empty-state copy). */
  seed?: { name: string } | null;
  /** Earlier messages couldn't be loaded; shows a one-line notice. */
  loadFailed: boolean;
  onQuickReply: (option: string) => void;
  /** Scroll the end of the thread into view as it grows (first scroll jumps, later ones are smooth). Default true. */
  autoScroll?: boolean;
  // Desktop workspace hooks. All optional and inert by default; the mobile page passes none of them.
  /** Called with a result card's key (`item:${kind}:${id}` / `place:${id}`) on pointer enter, `null` on leave. */
  onItemHover?: (key: string | null) => void;
  /** Key of the result card to ring. */
  highlightedKey?: string | null;
  /** Rendered at the end of each settled assistant turn (e.g. a "Show on map" chip). */
  renderReplyFooter?: (message: UiAssistantMessage) => ReactNode;
  /** Called when a catalogue item card is clicked, before the link navigates. */
  onItemClick?: (href: string, e: MouseEvent<HTMLAnchorElement>) => void;
}

/**
 * The conversation itself: load-failure notice, empty-state hero, every turn,
 * the pending seed card and the end sentinel. Renders a fragment, so the
 * caller supplies the scroll container / `<main>` (and its flex-col gap-4).
 */
export function ChatThread({
  messages,
  ready,
  sending,
  pendingStatus,
  pendingSeed,
  seed = null,
  loadFailed,
  onQuickReply,
  autoScroll = true,
  onItemHover,
  highlightedKey,
  renderReplyFooter,
  onItemClick,
}: ChatThreadProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  // First scroll after history loads jumps straight to bottom (no visible
  // scroll animation) so a seeded visit opens on the seed card + composer,
  // not mid-animation from wherever the top of a long history sits. Every
  // scroll after that (sends, quick replies) is the usual smooth one.
  const didInitialScroll = useRef(false);

  useEffect(() => {
    if (!ready || !autoScroll) return;
    const behavior: ScrollBehavior = didInitialScroll.current ? "smooth" : "auto";
    endRef.current?.scrollIntoView({ behavior, block: "end" });
    didInitialScroll.current = true;
  }, [messages.length, ready, autoScroll]);

  const empty = ready && messages.length === 0;

  return (
    <>
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
              : `I know what's on in ${CITY.name} right now: deals, free things and this week's events.`}
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
              <ThinkingDots label={pendingStatus} />
            </div>
          );
        }
        return (
          <Fragment key={m.id}>
            <AssistantTurn
              messageId={m.id}
              blocks={m.blocks}
              onQuickReply={onQuickReply}
              onItemHover={onItemHover}
              highlightedKey={highlightedKey}
              onItemClick={onItemClick}
              footer={renderReplyFooter?.(m)}
            />
            {m.signin ? <SigninCard question={m.signin.question} expired={m.signin.expired} /> : null}
          </Fragment>
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
    </>
  );
}
