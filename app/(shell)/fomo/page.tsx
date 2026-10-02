"use client";

import { Suspense, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ConfirmDialog, Icon } from "@/components/ui";
import { FomoFace } from "@/components/onboarding/Characters";
import { ChatComposer } from "@/components/fomo/chat/ChatComposer";
import { ChatThread } from "@/components/fomo/chat/ChatThread";
import { readChatSeed, type ChatSeed } from "@/lib/chat-seed";
import { useFomoChat } from "@/lib/fomo-chat/useFomoChat";

export default function FomoChatPage() {
  return (
    <Suspense fallback={null}>
      <FomoChatPageInner />
    </Suspense>
  );
}

function FomoChatPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Ask Fomo seed — set when this page was opened from a card's "Ask Fomo"
  // action rather than the plain FAB. Drives the inline seed context card,
  // the suggested-question chips, and the system prompt's context (all in
  // `useFomoChat`).
  const seed: ChatSeed | null = useMemo(() => readChatSeed(searchParams), [searchParams]);

  const chat = useFomoChat({
    seed,
    // Plain-text prefill (`?q=` from Book Early / Free Any Time's own "Ask
    // Fomo" buttons) — fills the composer without sending, on first mount only.
    initialInput: searchParams.get("q") ?? "",
    // `?q=…&send=1` (e.g. a shared/landing link) sends that question once, then
    // drops the params so a refresh doesn't ask it again.
    autoSend:
      searchParams.get("send") === "1"
        ? {
            question: searchParams.get("q")?.trim(),
            onStart: () => {
              const rest = new URLSearchParams(searchParams.toString());
              rest.delete("q");
              rest.delete("send");
              const qs = rest.toString();
              router.replace(qs ? `/fomo?${qs}` : "/fomo", { scroll: false });
            },
          }
        : null,
  });

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 flex items-center justify-between gap-2 bg-background/90 px-4 min-h-[56px] pt-safe backdrop-blur-sm">
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
            <FomoFace mood={chat.sending ? "hmm" : "grin"} className="h-8 w-8 drop-shadow-sm" />
          )}
          <h1 className="text-headline-sm text-primary">Ask Fomo</h1>
        </div>
        {chat.messages.length > 0 ? (
          <button
            type="button"
            aria-label="Clear chat"
            onClick={chat.requestClear}
            className="flex h-10 w-10 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-low"
          >
            <Icon name="delete_outline" />
          </button>
        ) : null}
      </header>

      <main className="flex flex-1 flex-col gap-4 px-4 pt-4 pb-[220px]">
        <ChatThread
          messages={chat.messages}
          ready={chat.ready}
          sending={chat.sending}
          pendingStatus={chat.pendingStatus}
          pendingSeed={chat.pendingSeed}
          seed={seed}
          loadFailed={chat.loadFailed}
          onQuickReply={(option) => void chat.send(option)}
        />
      </main>

      {/* Composer: suggested prompts + input bar, fixed above the bottom nav (and its safe-area inset). */}
      <ChatComposer
        layout="fixed"
        input={chat.input}
        onInputChange={chat.setInput}
        onSend={(text) => void chat.send(text)}
        sending={chat.sending}
        exhausted={chat.exhausted}
        signedIn={chat.signedIn}
        quota={chat.quota}
        suggestions={chat.suggestions}
      />

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
    </div>
  );
}
