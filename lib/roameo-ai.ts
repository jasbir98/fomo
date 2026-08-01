/**
 * Roameo AI — scripted/mocked chat layer (v0).
 *
 * No network calls. Pure, deterministic functions keyed off `mode` and
 * keyword matches in `userText`. Designed so a real LLM integration can
 * later replace `getChatReply` without changing its call sites: keep the
 * same signature, same `AiReplyBlock` shapes, swap the body for a real
 * API call.
 *
 * Source: `roameo_assistant_travel_chat/code.html` (Stitch prototype) for
 * the scripted Sushi Kanesaka lunch-reservation demo exchange.
 */

export type ChatMode = 'translate' | 'plan' | 'explain' | 'recommend' | 'emergency';

/** Rich place card rendered inline in an AI chat message. */
export interface PlaceCard {
  name: string;
  image_url: string;
  category: string;
  rating: number;
  /** e.g. "$$$$" */
  price_tier?: string;
  description: string;
  duration_label?: string;
  distance_label?: string;
  /** Button label + implied action, e.g. "Book Reservation" */
  cta_label?: string;
  /**
   * Short, personalized one-sentence explanation of *why this place was
   * recommended to this traveler* (e.g. "Recommended because it's a quiet
   * spot near your afternoon stop and matches your interest in temples").
   * Distinct from `description`, which describes the place itself.
   */
  reason?: string;
}

/**
 * A proposed itinerary insertion. The chat screen renders a
 * Confirm/Dismiss card from this; Confirm inserts an `itinerary_items` row
 * built from these fields (title/category/location/day_date/time_label/note).
 */
export interface ActionProposal {
  title: string;
  category: string;
  location: string;
  day_date?: string;
  time_label?: string;
  note?: string;
  /** Human-readable summary shown in the proposal card body. */
  summary: string;
  confirm_label?: string;
  dismiss_label?: string;
}

/**
 * A short list of tappable quick-reply options, optionally with a lead-in
 * question/prompt. Rendered as clickable chips; tapping one sends that
 * option as the traveler's next message. Used when the AI wants to offer
 * concrete choices or ask a clarifying question instead of guessing.
 */
export interface QuickReplies {
  /** Optional short lead-in question or text shown above the options. */
  prompt?: string;
  options: string[];
}

export type AiReplyBlock =
  | { kind: 'text'; text: string }
  | { kind: 'rich_card'; card: PlaceCard }
  | { kind: 'action_proposal'; proposal: ActionProposal }
  | { kind: 'quick_replies'; quick_replies: QuickReplies };

export interface ChatReply {
  blocks: AiReplyBlock[];
}

function includesAny(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

/** The scripted Sushi Kanesaka lunch-reservation demo (verbatim from prototype). */
const SUSHI_KANESAKA_REPLY: ChatReply = {
  blocks: [
    {
      kind: 'text',
      text: "Absolutely. Given your 2pm meeting location and preference for something upscale yet efficient, I highly recommend Sushi Kanesaka. It offers an exquisite omakase experience that can be paced to fit your schedule.",
    },
    {
      kind: 'rich_card',
      card: {
        name: 'Sushi Kanesaka',
        image_url:
          'https://images.unsplash.com/photo-1502364271109-0a9a75a2a9df?fm=jpg&q=60&w=1200&auto=format&fit=crop',
        category: 'Sushi restaurant',
        rating: 4.8,
        price_tier: '$$$$',
        description: 'Edome-style sushi in an elegant, serene setting in Ginza.',
        duration_label: '45-60 min',
        distance_label: '5 min away',
        cta_label: 'Book Reservation',
      },
    },
    {
      kind: 'action_proposal',
      proposal: {
        title: 'Lunch Reservation at Sushi Kanesaka',
        category: 'reservation',
        location: 'Sushi Kanesaka, Ginza',
        time_label: '12:45 PM',
        summary: 'Add a 12:45 PM lunch reservation at Sushi Kanesaka to your itinerary?',
        confirm_label: 'Confirm',
        dismiss_label: 'Dismiss',
      },
    },
  ],
};

const PLAN_DEMO_KEYWORDS = ['lunch', 'ginza', 'sushi', 'kanesaka', 'meeting', 'reservation'];

const TRANSLATE_STATION_KEYWORDS = ['station', 'train'];

function getPlanReply(userText: string): ChatReply {
  if (includesAny(userText, PLAN_DEMO_KEYWORDS)) {
    return SUSHI_KANESAKA_REPLY;
  }
  return {
    blocks: [
      {
        kind: 'text',
        text: "Tell me what's on the agenda — I can find a spot nearby, adjust timing around your plans, or add something new to your itinerary.",
      },
    ],
  };
}

function getTranslateReply(userText: string): ChatReply {
  if (includesAny(userText, TRANSLATE_STATION_KEYWORDS)) {
    return {
      blocks: [
        {
          kind: 'text',
          text: '最も近い駅はどこですか？\nMottomo chikai eki wa doko desu ka?\n\n("Where is the nearest train station?")',
        },
      ],
    };
  }
  return {
    blocks: [
      {
        kind: 'text',
        text: "I can translate phrases in real time. Type or say something and I'll translate it, or open the full Translator for voice and photo mode.",
      },
    ],
  };
}

function getExplainReply(userText: string): ChatReply {
  if (includesAny(userText, ['tip', 'tipping', 'gratuity'])) {
    return {
      blocks: [
        {
          kind: 'text',
          text: "Tipping isn't expected in Japan — at restaurants, taxis, or hotels. Excellent service is the default, not something you pay extra for. If someone goes out of their way for you, a sincere thank-you (arigatou gozaimasu) is the norm.",
        },
      ],
    };
  }
  if (includesAny(userText, ['shrine', 'temple', 'torii', 'etiquette'])) {
    return {
      blocks: [
        {
          kind: 'text',
          text: 'At a shrine: bow slightly before passing through the torii gate, purify your hands at the water basin, then bow twice, clap twice, and bow once more when praying. Temples are quieter — a respectful bow on entry is enough.',
        },
      ],
    };
  }
  return {
    blocks: [
      {
        kind: 'text',
        text: "Ask me about a custom, a sign, a menu item, or anything that seems unfamiliar and I'll break it down for you.",
      },
    ],
  };
}

function getRecommendReply(userText: string): ChatReply {
  if (includesAny(userText, PLAN_DEMO_KEYWORDS)) {
    return SUSHI_KANESAKA_REPLY;
  }
  return {
    blocks: [
      {
        kind: 'text',
        text: "Based on your Travel DNA, I'd steer you toward foodie-friendly spots with a bit of a local secret feel over the obvious tourist stops. Tell me a neighborhood or a craving and I'll narrow it down.",
      },
    ],
  };
}

function getEmergencyReply(): ChatReply {
  return {
    blocks: [
      {
        kind: 'text',
        text: "I've flagged this as urgent. In Japan: call 110 for police, 119 for fire or ambulance. Tell me what's happening and I can pull up the nearest hospital, your embassy's contact info, or share your location with a travel companion.",
      },
    ],
  };
}

/**
 * Returns a canned, mode-appropriate reply. Deterministic and pure — no
 * fetch, no side effects. Some replies are keyed off keywords in
 * `userText`; each mode has a sensible default otherwise.
 */
export function getChatReply(mode: ChatMode, userText: string): ChatReply {
  switch (mode) {
    case 'plan':
      return getPlanReply(userText);
    case 'translate':
      return getTranslateReply(userText);
    case 'explain':
      return getExplainReply(userText);
    case 'recommend':
      return getRecommendReply(userText);
    case 'emergency':
      return getEmergencyReply();
  }
}

const SUGGESTED_PROMPTS: Record<ChatMode, string[]> = {
  translate: ['Translate menu', 'Where is the station?', 'How do I say thank you?'],
  plan: ['Nav to meeting', 'Lunch near Ginza', 'Add this to my itinerary'],
  explain: ['Weather later', 'Shrine etiquette', 'Is tipping expected?'],
  recommend: ['Foodie spots nearby', 'Something off the beaten path', 'Best view at sunset'],
  emergency: ['I lost my passport', 'Nearest hospital', 'I need a translator now'],
};

/** Small set of canned suggested prompts shown as quick-tap chips per mode. */
export function getSuggestedPrompts(mode: ChatMode): string[] {
  return SUGGESTED_PROMPTS[mode];
}
