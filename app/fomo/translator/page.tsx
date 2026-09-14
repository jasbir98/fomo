"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { Icon, SegmentedControl } from "@/components/ui";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { uuid } from "@/lib/uuid";
import { CITY } from "@/lib/city";
import { getPreferences } from "@/lib/db";
import { QUICK_ACTIONS, type QuickAction } from "@/lib/translator-data";
import {
  ENGLISH_LANGUAGE,
  resolveLocalLanguage,
  resolveUserLanguage,
  type ResolvedLanguage,
} from "@/lib/language";
import { LanguagePicker } from "@/components/fomo/LanguagePicker";
import { downscaleImage, UnsupportedImageError } from "@/lib/image/downscale";
import type {
  TranslateErrorResult,
  TranslatePhotoItem,
  TranslatePhotoResult,
  TranslateTextResult,
} from "@/lib/ai/translate-types";

type TransMode = "text" | "photo";
type LanguageSlot = "source" | "target";

interface TextEntry {
  id: string;
  kind: "text";
  sourceText: string;
  translation: string;
  pronunciation: string;
  note?: string;
  targetBcp47?: string;
}

interface PhotoEntry {
  id: string;
  kind: "photo";
  imageDataUrl: string;
  items: TranslatePhotoItem[];
  summary?: string;
  targetBcp47?: string;
}

type TranscriptEntry = TextEntry | PhotoEntry;

const QUICK_ACTION_ICON: Record<QuickAction, string> = {
  "Repeat Slow": "volume_up",
  "Save Phrase": "bookmark_add",
  "Ask Follow-up": "auto_awesome",
};

/** Browser TTS for the "Repeat Slow" quick action. No-op if unsupported. */
function speakSlowly(text: string, bcp47?: string) {
  if (!text) return;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.75;
  if (bcp47) utterance.lang = bcp47;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function photoRepeatText(e: PhotoEntry): string {
  if (e.summary) return e.summary;
  return e.items.map((item) => item.translation).join(". ");
}

export default function TranslatorPage() {
  const router = useRouter();
  const db = supabaseBrowserAuth();

  const [sourceLang, setSourceLang] = useState<ResolvedLanguage>(ENGLISH_LANGUAGE);
  const [targetLang, setTargetLang] = useState<ResolvedLanguage>(() =>
    resolveLocalLanguage(null)
  );
  const [pickerSlot, setPickerSlot] = useState<LanguageSlot | null>(null);
  const [mode, setMode] = useState<TransMode>("text");
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [textInput, setTextInput] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const from = sourceLang;
  const to = targetLang;

  // Load the active trip + Travel DNA on mount to derive the destination's
  // local language (and the traveler's own language).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const prefs = await getPreferences(db);
        if (cancelled) return;
        // One city, so the target language is simply Edinburgh's. Kept
        // resolver-driven rather than hardcoded to English so adding a second
        // city stays a lib/city.ts change.
        setTargetLang(resolveLocalLanguage(CITY.name));
        setSourceLang(resolveUserLanguage(prefs?.languages));
      } catch (err) {
        console.error("[translator] failed to load trip/preferences", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length]);

  function pushEntry(entry: TranscriptEntry) {
    setEntries((prev) => [...prev, entry]);
  }

  function swap() {
    setSourceLang(targetLang);
    setTargetLang(sourceLang);
  }

  async function handleSendText() {
    const trimmed = textInput.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setTextInput("");

    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "text",
          text: trimmed,
          sourceLang: from.promptPhrase,
          targetLang: to.promptPhrase,
        }),
      });
      const data = (await res.json()) as TranslateTextResult | TranslateErrorResult;

      if (!res.ok || "error" in data) {
        pushEntry({
          id: uuid(),
          kind: "text",
          sourceText: trimmed,
          translation:
            "error" in data
              ? data.message ?? data.error
              : "Fomo hit a snag translating that. Please try again.",
          pronunciation: "",
          targetBcp47: to.bcp47,
        });
        return;
      }

      pushEntry({
        id: uuid(),
        kind: "text",
        sourceText: data.sourceText || trimmed,
        translation: data.translation,
        pronunciation: data.pronunciation,
        note: data.note,
        targetBcp47: to.bcp47,
      });
    } catch (err) {
      console.error("[translator] text translate failed", err);
      pushEntry({
        id: uuid(),
        kind: "text",
        sourceText: trimmed,
        translation: "Fomo hit a snag reaching the AI. Please try again.",
        pronunciation: "",
        targetBcp47: to.bcp47,
      });
    } finally {
      setSending(false);
    }
  }

  async function handlePhotoSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file next time
    if (!file || sending) return;
    setSending(true);

    let dataUrl = "";
    try {
      const downscaled = await downscaleImage(file);
      dataUrl = downscaled.dataUrl;

      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "photo",
          imageBase64: downscaled.base64,
          mediaType: downscaled.mediaType,
          targetLang: to.promptPhrase,
        }),
      });
      const data = (await res.json()) as TranslatePhotoResult | TranslateErrorResult;

      if (!res.ok || "error" in data) {
        pushEntry({
          id: uuid(),
          kind: "photo",
          imageDataUrl: dataUrl,
          items: [],
          summary:
            "error" in data
              ? data.message ?? data.error
              : "Fomo couldn't read that photo. Please try again.",
          targetBcp47: to.bcp47,
        });
        return;
      }

      pushEntry({
        id: uuid(),
        kind: "photo",
        imageDataUrl: dataUrl,
        items: data.items,
        summary: data.summary,
        targetBcp47: to.bcp47,
      });
    } catch (err) {
      console.error("[translator] photo translate failed", err);
      pushEntry({
        id: uuid(),
        kind: "photo",
        imageDataUrl: dataUrl,
        items: [],
        summary:
          err instanceof UnsupportedImageError
            ? "Fomo couldn't open that photo format. Try a JPEG photo or a screenshot instead."
            : "Fomo hit a snag reading that photo. Please try again.",
        targetBcp47: to.bcp47,
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      {/* Header — Close returns to Fomo chat */}
      <header className="flex h-[72px] shrink-0 items-center justify-between px-5 pt-safe">
        <button
          type="button"
          aria-label="Close Translator"
          onClick={() => router.push("/fomo")}
          className="flex h-12 w-12 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-low"
        >
          <Icon name="close" />
        </button>
        <div className="flex items-center gap-2">
          <Icon name="auto_awesome" filled size={20} className="text-primary" />
          <h1 className="text-headline-sm text-primary">Translator</h1>
        </div>
        <button
          type="button"
          aria-label="Settings"
          aria-disabled="true"
          disabled
          className="flex h-12 w-12 items-center justify-center rounded-full text-on-surface-variant opacity-40 cursor-not-allowed"
        >
          <Icon name="more_vert" />
        </button>
      </header>

      {/* Controls: language selector + Text/Photo toggle */}
      <section className="flex shrink-0 flex-col gap-4 bg-background px-5 pb-2">
        <div className="mx-auto flex w-full max-w-md items-center justify-between rounded-full border border-surface-variant bg-surface-container p-1 shadow-sm">
          <button
            type="button"
            onClick={() => setPickerSlot("source")}
            className="flex-1 truncate rounded-full px-4 py-2.5 text-center text-label-md font-medium text-on-surface transition-colors hover:bg-surface-container-high"
          >
            {from.label}
          </button>
          <button
            type="button"
            aria-label="Swap languages"
            onClick={swap}
            className="z-10 -mx-3 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-surface-variant bg-surface text-primary shadow-sm transition-colors hover:bg-surface-container-low"
          >
            <Icon name="sync_alt" filled size={20} />
          </button>
          <button
            type="button"
            onClick={() => setPickerSlot("target")}
            className="flex-1 truncate rounded-full px-4 py-2.5 text-center text-label-md font-medium text-on-surface transition-colors hover:bg-surface-container-high"
          >
            {to.label}
          </button>
        </div>

        <div className="flex justify-center">
          <SegmentedControl<TransMode>
            value={mode}
            onChange={setMode}
            options={[
              { value: "text", label: "Text", icon: "keyboard" },
              { value: "photo", label: "Photo", icon: "photo_camera" },
            ]}
          />
        </div>
      </section>

      {/* Transcript canvas */}
      <main className="relative z-0 flex flex-1 flex-col gap-8 overflow-y-auto px-5 py-6">
        {entries.length === 0 ? (
          <div className="mt-16 flex flex-col items-center gap-3 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-secondary-container/20 text-secondary-container">
              <Icon name={mode === "text" ? "keyboard" : "photo_camera"} size={32} />
            </span>
            <p className="text-body-lg text-on-surface">
              {mode === "text"
                ? `Type a phrase in ${from.label}.`
                : "Snap a photo of a menu or sign."}
            </p>
            <p className="text-body-md text-on-surface-variant">
              Fomo translates it to {to.label} in real time.
            </p>
          </div>
        ) : null}

        {entries.map((e, i) => {
          const last = i === entries.length - 1;
          return (
            <div key={e.id} className={last ? "" : "opacity-60"}>
              {e.kind === "text" ? (
                <>
                  {/* Spoken (user) bubble */}
                  <div className="flex w-full flex-col items-end gap-1">
                    <div
                      className={`max-w-[85%] rounded-2xl rounded-tr-sm p-4 ${
                        last
                          ? "bg-primary text-on-primary shadow-md"
                          : "bg-surface-container text-on-surface"
                      }`}
                    >
                      <p className="text-body-lg">{e.sourceText}</p>
                    </div>
                    {last ? (
                      <span className="mr-1 text-[10px] font-semibold text-on-surface-variant">
                        Just now
                      </span>
                    ) : null}
                  </div>

                  {/* Translated result + pronunciation + quick actions */}
                  <div className="mt-3 flex w-full flex-col items-start gap-3">
                    <div className="relative max-w-[95%] overflow-hidden rounded-2xl rounded-tl-sm border border-surface-variant bg-surface-container-lowest p-5 shadow-sm">
                      <span
                        className="absolute left-0 top-0 bottom-0 w-1.5 rounded-l-2xl bg-primary-fixed-dim"
                        aria-hidden="true"
                      />
                      <div className="pl-2">
                        <p className="mb-2 text-headline-md font-bold leading-tight text-primary">
                          {e.translation}
                        </p>
                        {e.pronunciation ? (
                          <p className="text-body-md tracking-wide text-on-surface-variant">
                            {e.pronunciation}
                          </p>
                        ) : null}
                        {e.note ? (
                          <p className="mt-2 text-label-sm text-on-surface-variant">
                            {e.note}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    {last ? (
                      <QuickActionRow
                        onRepeat={() => speakSlowly(e.translation, e.targetBcp47)}
                      />
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  {/* Captured photo thumbnail */}
                  <div className="flex w-full flex-col items-end gap-1">
                    {e.imageDataUrl ? (
                      <div
                        className={`max-w-[70%] overflow-hidden rounded-2xl rounded-tr-sm ${
                          last ? "shadow-md" : ""
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={e.imageDataUrl}
                          alt="Captured menu or sign"
                          className="block max-h-[220px] w-full object-cover"
                        />
                      </div>
                    ) : null}
                    {last ? (
                      <span className="mr-1 text-[10px] font-semibold text-on-surface-variant">
                        Just now
                      </span>
                    ) : null}
                  </div>

                  {/* Detected + translated items + quick actions */}
                  <div className="mt-3 flex w-full flex-col items-start gap-3">
                    <div className="relative max-w-[95%] overflow-hidden rounded-2xl rounded-tl-sm border border-surface-variant bg-surface-container-lowest p-5 shadow-sm">
                      <span
                        className="absolute left-0 top-0 bottom-0 w-1.5 rounded-l-2xl bg-primary-fixed-dim"
                        aria-hidden="true"
                      />
                      <div className="flex flex-col gap-4 pl-2">
                        {e.summary ? (
                          <p className="text-body-md text-on-surface-variant">
                            {e.summary}
                          </p>
                        ) : null}
                        {e.items.length === 0 ? (
                          <p className="text-body-md text-on-surface-variant">
                            No text detected in that photo.
                          </p>
                        ) : (
                          e.items.map((item, idx) => (
                            <div
                              key={idx}
                              className={
                                idx > 0 ? "border-t border-surface-variant pt-3" : ""
                              }
                            >
                              <p className="mb-1 text-label-sm text-on-surface-variant">
                                {item.original}
                              </p>
                              <p className="text-headline-sm font-bold leading-tight text-primary">
                                {item.translation}
                              </p>
                              {item.pronunciation ? (
                                <p className="mt-1 text-body-sm tracking-wide text-on-surface-variant">
                                  {item.pronunciation}
                                </p>
                              ) : null}
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {last ? (
                      <QuickActionRow
                        onRepeat={() => speakSlowly(photoRepeatText(e), e.targetBcp47)}
                      />
                    ) : null}
                  </div>
                </>
              )}
            </div>
          );
        })}
        <div className="h-24 shrink-0" />
        <div ref={endRef} />
      </main>

      {/* Composer: text input (Text mode) or capture button (Photo mode) */}
      <div className="pointer-events-none absolute bottom-0 left-1/2 z-30 flex w-full max-w-[480px] -translate-x-1/2 flex-col items-center justify-center bg-gradient-to-t from-background via-background/95 to-transparent px-5 pb-8 pt-12">
        {mode === "text" ? (
          <form
            onSubmit={(evt) => {
              evt.preventDefault();
              void handleSendText();
            }}
            className="pointer-events-auto flex w-full items-end gap-2 rounded-2xl border border-outline-variant/60 bg-surface p-2 shadow-[0_2px_12px_rgba(3,22,50,0.06)] focus-within:border-primary focus-within:ring-1 focus-within:ring-primary"
          >
            <input
              value={textInput}
              onChange={(evt) => setTextInput(evt.target.value)}
              placeholder={`Type in ${from.label}...`}
              disabled={sending}
              className="min-h-[44px] flex-1 border-none bg-transparent px-3 text-body-md text-on-surface outline-none placeholder:text-outline focus:ring-0"
            />
            <button
              type="submit"
              aria-label="Send"
              disabled={sending || !textInput.trim()}
              className="shrink-0 rounded-xl bg-secondary-container p-3 text-on-secondary-container shadow-sm transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Icon name={sending ? "hourglass_empty" : "arrow_upward"} filled={!sending} />
            </button>
          </form>
        ) : (
          <div className="pointer-events-auto relative flex flex-col items-center">
            <span
              className="absolute inset-0 -z-10 m-auto h-[100px] w-[100px] scale-150 rounded-full bg-secondary-container/15"
              aria-hidden="true"
            />
            <label
              aria-label="Take a photo to translate"
              className={`flex h-[88px] w-[88px] items-center justify-center rounded-full bg-secondary-container text-on-secondary-container shadow-lg transition-transform active:scale-95 hover:opacity-90 ${
                sending ? "pointer-events-none opacity-70" : "cursor-pointer"
              }`}
            >
              <input
                type="file"
                accept="image/*"
                capture="environment"
                disabled={sending}
                onChange={(evt) => void handlePhotoSelected(evt)}
                className="hidden"
              />
              <Icon
                name={sending ? "hourglass_empty" : "photo_camera"}
                filled={!sending}
                size={40}
              />
            </label>
            <p className="mt-4 rounded-full bg-background/80 px-4 py-1 text-center text-label-md font-medium text-on-surface-variant backdrop-blur-sm">
              {sending
                ? "Reading the photo..."
                : `Snap a menu or sign to translate to ${to.label}`}
            </p>
          </div>
        )}
      </div>

      <LanguagePicker
        open={pickerSlot !== null}
        onClose={() => setPickerSlot(null)}
        title={pickerSlot === "source" ? "Translate from" : "Translate to"}
        current={pickerSlot === "source" ? sourceLang.label : targetLang.label}
        onSelect={(lang) => {
          if (pickerSlot === "source") setSourceLang(lang);
          else if (pickerSlot === "target") setTargetLang(lang);
        }}
      />
    </div>
  );
}

function QuickActionRow({ onRepeat }: { onRepeat: () => void }) {
  return (
    <div className="flex flex-wrap gap-2 pl-1">
      {QUICK_ACTIONS.map((action) => {
        const enabled = action === "Repeat Slow";
        return (
          <button
            key={action}
            type="button"
            onClick={enabled ? onRepeat : undefined}
            disabled={!enabled}
            aria-disabled={!enabled}
            className={`inline-flex h-[36px] items-center gap-1.5 rounded-full border border-surface-variant bg-surface-container-low px-3.5 py-2 text-label-sm font-semibold text-primary shadow-sm transition-colors ${
              enabled
                ? "hover:bg-surface-container"
                : "opacity-40 cursor-not-allowed"
            }`}
          >
            <Icon name={QUICK_ACTION_ICON[action]} size={18} />
            {action}
          </button>
        );
      })}
    </div>
  );
}
