/**
 * Best-effort destination → local-language resolution for the Translator.
 *
 * No network calls, no exhaustive coverage — just enough to (a) give Claude a
 * concrete target-language instruction when we can, and (b) pick a sensible
 * BCP-47 tag for browser TTS. When a destination doesn't match anything
 * here, callers fall back to a descriptive phrase ("the local language of
 * {destination}") that Claude can still act on correctly.
 */

export interface ResolvedLanguage {
  /** Short label for UI display, e.g. "Japanese" or "Local Language". */
  label: string;
  /** Phrase to send to Claude as sourceLang/targetLang, e.g. "Japanese". */
  promptPhrase: string;
  /** BCP-47 tag for speechSynthesis, if known. */
  bcp47?: string;
}

interface LanguageInfo {
  name: string;
  bcp47: string;
}

/** Lowercase place-name fragment → language. Matched via substring search. */
const DESTINATION_LANGUAGES: Record<string, LanguageInfo> = {
  japan: { name: "Japanese", bcp47: "ja-JP" },
  france: { name: "French", bcp47: "fr-FR" },
  italy: { name: "Italian", bcp47: "it-IT" },
  spain: { name: "Spanish", bcp47: "es-ES" },
  mexico: { name: "Spanish", bcp47: "es-MX" },
  germany: { name: "German", bcp47: "de-DE" },
  austria: { name: "German", bcp47: "de-AT" },
  switzerland: { name: "German", bcp47: "de-CH" },
  china: { name: "Mandarin Chinese", bcp47: "zh-CN" },
  taiwan: { name: "Mandarin Chinese", bcp47: "zh-TW" },
  "south korea": { name: "Korean", bcp47: "ko-KR" },
  korea: { name: "Korean", bcp47: "ko-KR" },
  thailand: { name: "Thai", bcp47: "th-TH" },
  vietnam: { name: "Vietnamese", bcp47: "vi-VN" },
  portugal: { name: "Portuguese", bcp47: "pt-PT" },
  brazil: { name: "Portuguese", bcp47: "pt-BR" },
  netherlands: { name: "Dutch", bcp47: "nl-NL" },
  greece: { name: "Greek", bcp47: "el-GR" },
  turkey: { name: "Turkish", bcp47: "tr-TR" },
  russia: { name: "Russian", bcp47: "ru-RU" },
  egypt: { name: "Arabic", bcp47: "ar-EG" },
  "united arab emirates": { name: "Arabic", bcp47: "ar-AE" },
  "saudi arabia": { name: "Arabic", bcp47: "ar-SA" },
  morocco: { name: "Arabic", bcp47: "ar-MA" },
  india: { name: "Hindi", bcp47: "hi-IN" },
  indonesia: { name: "Indonesian", bcp47: "id-ID" },
  poland: { name: "Polish", bcp47: "pl-PL" },
  sweden: { name: "Swedish", bcp47: "sv-SE" },
  norway: { name: "Norwegian", bcp47: "no-NO" },
  denmark: { name: "Danish", bcp47: "da-DK" },
  finland: { name: "Finnish", bcp47: "fi-FI" },
  "czech republic": { name: "Czech", bcp47: "cs-CZ" },
  hungary: { name: "Hungarian", bcp47: "hu-HU" },
  israel: { name: "Hebrew", bcp47: "he-IL" },
  "united kingdom": { name: "English", bcp47: "en-GB" },
  "united states": { name: "English", bcp47: "en-US" },
  usa: { name: "English", bcp47: "en-US" },
  canada: { name: "English", bcp47: "en-CA" },
  australia: { name: "English", bcp47: "en-AU" },
  philippines: { name: "Filipino", bcp47: "fil-PH" },
  malaysia: { name: "Malay", bcp47: "ms-MY" },
  kenya: { name: "Swahili", bcp47: "sw-KE" },
  tanzania: { name: "Swahili", bcp47: "sw-TZ" },
  romania: { name: "Romanian", bcp47: "ro-RO" },
  ukraine: { name: "Ukrainian", bcp47: "uk-UA" },
  bangladesh: { name: "Bengali", bcp47: "bn-BD" },
  pakistan: { name: "Urdu", bcp47: "ur-PK" },
  iran: { name: "Persian", bcp47: "fa-IR" },
  croatia: { name: "Croatian", bcp47: "hr-HR" },
  serbia: { name: "Serbian", bcp47: "sr-RS" },
  slovakia: { name: "Slovak", bcp47: "sk-SK" },
  bulgaria: { name: "Bulgarian", bcp47: "bg-BG" },
  "sri lanka": { name: "Tamil", bcp47: "ta-LK" },
  "south africa": { name: "Afrikaans", bcp47: "af-ZA" },
};

export const ENGLISH_LANGUAGE: ResolvedLanguage = {
  label: "English",
  promptPhrase: "English",
  bcp47: "en-US",
};

/** Look up a BCP-47 tag for a language name (as returned by our own map). */
function bcp47ForName(languageName: string): string | undefined {
  const needle = languageName.trim().toLowerCase();
  if (needle === "english") return ENGLISH_LANGUAGE.bcp47;
  for (const info of Object.values(DESTINATION_LANGUAGES)) {
    if (info.name.toLowerCase() === needle) return info.bcp47;
  }
  return undefined;
}

/**
 * Full list of languages the user can pick from in the Translator's language
 * picker. `DESTINATION_LANGUAGES` is keyed by country (several countries
 * share a language, e.g. Austria/Germany/Switzerland → German), so this
 * dedupes by language name, adds English, and sorts alphabetically.
 */
export const SELECTABLE_LANGUAGES: { name: string; bcp47: string }[] = (() => {
  const byName = new Map<string, string>();
  byName.set(ENGLISH_LANGUAGE.label, ENGLISH_LANGUAGE.bcp47 as string);
  for (const info of Object.values(DESTINATION_LANGUAGES)) {
    if (!byName.has(info.name)) byName.set(info.name, info.bcp47);
  }
  return Array.from(byName, ([name, bcp47]) => ({ name, bcp47 })).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
})();

/** Resolve a `ResolvedLanguage` from a language name picked in the UI. */
export function languageFromName(name: string): ResolvedLanguage {
  return { label: name, promptPhrase: name, bcp47: bcp47ForName(name) };
}

/**
 * Resolve the "local" language for a trip destination. Falls back to a
 * descriptive phrase Claude can still translate against correctly when the
 * destination isn't in our small lookup table.
 */
export function resolveLocalLanguage(
  destination: string | null | undefined
): ResolvedLanguage {
  const dest = destination?.trim();
  if (dest) {
    const needle = dest.toLowerCase();
    for (const [key, info] of Object.entries(DESTINATION_LANGUAGES)) {
      if (needle.includes(key)) {
        return { label: info.name, promptPhrase: info.name, bcp47: info.bcp47 };
      }
    }
  }
  return {
    label: "Local Language",
    promptPhrase: dest
      ? `the local language of ${dest}`
      : "the local language of the traveler's destination",
  };
}

/** Resolve the traveler's own language from Travel DNA preferences. */
export function resolveUserLanguage(
  languages: string[] | null | undefined
): ResolvedLanguage {
  const first = languages?.[0]?.trim();
  if (!first) return ENGLISH_LANGUAGE;
  return { label: first, promptPhrase: first, bcp47: bcp47ForName(first) };
}
