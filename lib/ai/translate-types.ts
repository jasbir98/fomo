/**
 * Shared request/response shapes for the Translator's real Claude-powered
 * `/api/translate` route.
 *
 * Pure types only — no "use client" or "server-only" directive — so both the
 * client page (`app/fomo/translator/page.tsx`) and the server route
 * handler (`app/api/translate/route.ts`) can import from here without either
 * side pulling code across the client/server boundary.
 */

export interface TranslateTextRequest {
  kind: "text";
  /** Text to translate, in `sourceLang`. */
  text: string;
  /** Human-readable source language name or description, e.g. "English". */
  sourceLang: string;
  /** Human-readable target language name or description, e.g. "Japanese". */
  targetLang: string;
}

export interface TranslatePhotoRequest {
  kind: "photo";
  /** Raw base64 image data — no `data:` prefix, no newlines. */
  imageBase64: string;
  /** Image MIME type, e.g. "image/jpeg". */
  mediaType: string;
  /** Human-readable target language name or description, e.g. "Japanese". */
  targetLang: string;
}

export type TranslateRequest = TranslateTextRequest | TranslatePhotoRequest;

export interface TranslateTextResult {
  /** The original source text, echoed back verbatim. */
  sourceText: string;
  /** The translation into the target language. */
  translation: string;
  /** Romanized/phonetic pronunciation guide; empty string if not applicable. */
  pronunciation: string;
  /** Optional short usage or cultural note. */
  note?: string;
}

export interface TranslatePhotoItem {
  /** The original text as detected in the image. */
  original: string;
  /** The translation of that text into the target language. */
  translation: string;
  /** Romanized/phonetic pronunciation guide; empty string if not applicable. */
  pronunciation?: string;
}

export interface TranslatePhotoResult {
  /** One entry per detected menu line / sign phrase. */
  items: TranslatePhotoItem[];
  /** Optional one-sentence summary of what the image shows. */
  summary?: string;
}

export interface TranslateErrorResult {
  /** Machine-readable error code, e.g. "rate_limited". */
  error: string;
  /** Human-friendly message to show in place of the error code — prefer this over `error` when present (e.g. the 429 rate-limit response from app/api/translate). */
  message?: string;
  /** Present on a 429 rate-limit response — ISO timestamp the window resets at. */
  resetAt?: string;
}
