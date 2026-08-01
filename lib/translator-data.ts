/**
 * Roameo Translator — fixed EN⇄JA phrase table (v0, mocked).
 *
 * No network calls. `translate()` looks up a fixed table; `getDemoTranscript()`
 * replays the exact scripted exchange shown in the prototype
 * (`translator_voice_photo/code.html`) so the "hold to speak" button has a
 * deterministic conversation to cycle through.
 */

export type Direction = 'en-ja' | 'ja-en';

export interface PhrasePair {
  /** English text */
  source: string;
  /** Japanese text */
  target: string;
  /** Romanized reading of `target` */
  romaji: string;
  note?: string;
}

/**
 * Fixed phrase table. The first two entries are the exact exchange shown in
 * the prototype (station wayfinding); the rest round out common travel
 * categories (greetings, ordering food, asking for help) in the same shape.
 */
export const PHRASE_TABLE: PhrasePair[] = [
  {
    source: 'Excuse me, could you point me to the ticket counter?',
    target: 'すみません、切符売り場はどこですか？',
    romaji: 'Sumimasen, kippu uriba wa doko desu ka?',
    note: 'From the prototype demo transcript (previous turn).',
  },
  {
    source: 'Where is the nearest train station?',
    target: '最も近い駅はどこですか？',
    romaji: 'Mottomo chikai eki wa doko desu ka?',
    note: 'From the prototype demo transcript (current turn).',
  },
  {
    source: 'Hello',
    target: 'こんにちは',
    romaji: 'Konnichiwa',
  },
  {
    source: 'Thank you very much',
    target: 'どうもありがとうございます',
    romaji: 'Doumo arigatou gozaimasu',
  },
  {
    source: 'Do you have an English menu?',
    target: '英語のメニューはありますか？',
    romaji: 'Eigo no menyuu wa arimasu ka?',
  },
  {
    source: 'I would like to order this, please.',
    target: 'これをお願いします。',
    romaji: 'Kore o onegaishimasu.',
  },
  {
    source: 'Where is the restroom?',
    target: 'お手洗いはどこですか？',
    romaji: 'Otearai wa doko desu ka?',
  },
  {
    source: 'How much is this?',
    target: 'これはいくらですか？',
    romaji: 'Kore wa ikura desu ka?',
  },
  {
    source: "I don't understand.",
    target: 'わかりません。',
    romaji: 'Wakarimasen.',
  },
  {
    source: 'Could you say that again, slowly?',
    target: 'もう一度、ゆっくり言っていただけますか？',
    romaji: 'Mou ichido, yukkuri itte itadakemasu ka?',
  },
];

/** Quick-action chip labels shown under a translated result. */
export const QUICK_ACTIONS = ['Repeat Slow', 'Save Phrase', 'Ask Follow-up'] as const;
export type QuickAction = (typeof QUICK_ACTIONS)[number];

const FALLBACK_PAIR: PhrasePair = {
  source: "I don't understand.",
  target: 'わかりません。',
  romaji: 'Wakarimasen.',
  note: 'Fallback — no exact match in the phrase table.',
};

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Looks up `text` in the fixed phrase table for the given direction.
 * `dir: 'en-ja'` matches against `source`; `dir: 'ja-en'` matches against
 * `target`. Falls back to a graceful default pair if nothing matches.
 */
export function translate(text: string, dir: Direction): PhrasePair {
  const needle = normalize(text);
  const match = PHRASE_TABLE.find((pair) =>
    dir === 'en-ja' ? normalize(pair.source) === needle : normalize(pair.target) === needle
  );
  return match ?? FALLBACK_PAIR;
}

/**
 * Ordered scripted transcript for the "hold to speak" demo, replaying the
 * exact exchange from the prototype. `dir` only affects which side is
 * treated as "spoken" by the user; the pair content is the same either way.
 */
export function getDemoTranscript(dir: Direction): PhrasePair[] {
  const transcript = [PHRASE_TABLE[0], PHRASE_TABLE[1]];
  return dir === 'en-ja' ? transcript : [...transcript].reverse();
}
