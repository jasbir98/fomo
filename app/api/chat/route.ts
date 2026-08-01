/**
 * Roameo AI chat — real streaming Claude integration (server-only).
 *
 * Replaces the scripted `getChatReply` mock. The client POSTs the chat context
 * (mode, history, userText, trip, Travel DNA preferences, rules) and this route
 * calls Claude with a mode-tailored system prompt + two structured-action tools.
 *
 * Transport: the response body is a stream of newline-delimited JSON events —
 *   {"type":"text_delta","text":"..."}   (0..n, streamed as the model types)
 *   {"type":"done","blocks":[...]}        (final, assembled AiReplyBlock[])
 *   {"type":"error","message":"..."}      (on failure, client shows a fallback)
 *
 * The API key lives only in the server env (via getAnthropic()); it never
 * reaches the client bundle.
 */
import "server-only";
import { getAnthropic, CHAT_MODEL } from "@/lib/ai/anthropic";
import type {
  ActionProposal,
  AiReplyBlock,
  ChatMode,
  PlaceCard,
} from "@/lib/roameo-ai";
import type { CardSubjectType, TravelPreferences } from "@/lib/types";

export const runtime = "nodejs";

type HistoryTurn = { role: "user" | "assistant"; text: string };

interface TripContext {
  destination: string | null;
  name: string | null;
  start_date: string | null;
  end_date: string | null;
}

/** plan-v1-home-pivot.md §7 — set when the client opened chat from a card's "Ask Roameo" action, carrying what the card was about. */
interface ChatSeedContext {
  type: CardSubjectType;
  name: string;
  city: string | null;
}

interface ChatRequestBody {
  mode: ChatMode;
  history: HistoryTurn[];
  userText: string;
  trip: TripContext | null;
  preferences: TravelPreferences | null;
  rules: string | null;
  seed?: ChatSeedContext | null;
}

const MODE_GUIDANCE: Record<ChatMode, string> = {
  translate:
    "You are in TRANSLATE mode. Translate the traveler's phrases into the local language of the trip destination. For each translation, give the phrase in the local script, then a pronunciation guide (romanized), then a literal English gloss in parentheses. Keep it practical and ready to speak aloud.",
  plan:
    "You are in PLAN mode. Help the traveler schedule or adjust their itinerary. When you want to add a concrete thing to the itinerary (a reservation, an activity, a stop), call the propose_itinerary_item tool so the app can render a Confirm/Dismiss card. Reason about timing around their existing plans.",
  explain:
    "You are in EXPLAIN mode. Explain local customs, etiquette, signs, menu items, or anything unfamiliar at the destination. Be concrete and respectful; give the traveler enough context to act correctly and confidently.",
  recommend:
    "You are in RECOMMEND mode. Recommend places that match the traveler's Travel DNA. When you recommend a specific place worth a rich card, call the suggest_place tool. Favor spots that fit their sliders, interests, and dietary needs over generic tourist stops.",
  emergency:
    "You are in EMERGENCY mode. Stay calm and safety-first. Surface the destination country's real emergency numbers (police, ambulance/fire) accurately — do not invent numbers; if you are unsure of a specific local number, say so and give the traveler a reliable way to find it. Be concise, clear, and reassuring, and offer concrete next steps. If you need to narrow down what's wrong, you may use suggest_quick_replies for a fast one-tap answer (e.g. \"Lost item\", \"Medical\", \"Lost/stranded\") — but never let clarifying delay an obviously urgent situation; give the essential safety info first.",
};

function buildSystemPrompt(body: ChatRequestBody): string {
  const { mode, trip, preferences, rules, seed } = body;
  const parts: string[] = [];

  parts.push(
    "You are Roameo, a knowledgeable local friend texting the traveler — warm and opinionated, never a dense guidebook. When you're not sure, commit to one recommendation and say why, rather than hedging with a list of options. Be specific: name the street, the stall, the dish, the exact thing that makes your answer worth more than a search result. You have three tools for structured actions: propose_itinerary_item (to add something to the itinerary), suggest_place (to surface a rich place card), and suggest_quick_replies (to offer 2-5 short tappable options and/or ask a clarifying question). Use them when they fit; otherwise just reply in text.\n\nKeep replies short: 1-3 sentences of prose by default. Answer the traveler's actual question directly first — don't restate it, don't preface with throat-clearing or generic scene-setting, don't list caveats or background the traveler didn't ask for. When a rich_card or propose_itinerary_item covers the details (name, description, timing), the prose reply should be a brief one-line lead-in, not a duplicate of the card's content. Only go longer than a few sentences if the traveler explicitly asks for more detail, a full explanation, or a list.\n\nWhen the traveler's request is vague, ambiguous, or too open-ended to act on well (e.g. \"plan something for me\", \"find me food\", \"what should I do\"), don't just guess — call suggest_quick_replies to offer a few concrete options or ask a short clarifying question, then wait for their tap. Don't overuse it: if the request is already clear enough to act on, just answer or use the other tools instead."
  );

  parts.push(MODE_GUIDANCE[mode]);

  if (seed) {
    parts.push(
      `The traveler opened this chat by tapping "Ask Roameo" on a ${seed.type} card: "${seed.name}"${
        seed.city ? ` in ${seed.city}` : ""
      }. Assume their first message is about this specific ${seed.type} unless they clearly change the subject — answer as if you already know exactly what they're pointing at, don't ask them to clarify which place/event/experience they mean.`
    );
  }

  if (trip) {
    const tripLines: string[] = [];
    if (trip.destination) tripLines.push(`Destination: ${trip.destination}`);
    if (trip.name) tripLines.push(`Trip name: ${trip.name}`);
    if (trip.start_date || trip.end_date) {
      tripLines.push(
        `Dates: ${trip.start_date ?? "?"} to ${trip.end_date ?? "?"}`
      );
    }
    if (tripLines.length > 0) {
      parts.push(`Current trip:\n${tripLines.join("\n")}`);
    }
  }

  if (preferences) {
    const dna: string[] = [];
    const slider = (
      label: string,
      value: number | null,
      low: string,
      high: string
    ) => {
      if (value == null) return;
      dna.push(`${label}: ${value}/100 (0 = ${low}, 100 = ${high})`);
    };
    slider(
      "Luxury vs backpacker",
      preferences.luxury_backpacker,
      "backpacker",
      "luxury"
    );
    slider(
      "Planned vs spontaneous",
      preferences.planned_spontaneous,
      "planned",
      "spontaneous"
    );
    slider(
      "Foodie vs utilitarian",
      preferences.foodie_utilitarian,
      "utilitarian",
      "foodie"
    );
    if (preferences.interests?.length)
      dna.push(`Interests: ${preferences.interests.join(", ")}`);
    if (preferences.dietary?.length)
      dna.push(`Dietary needs: ${preferences.dietary.join(", ")}`);
    if (preferences.mobility?.length)
      dna.push(`Mobility considerations: ${preferences.mobility.join(", ")}`);
    if (preferences.languages?.length)
      dna.push(`Languages spoken: ${preferences.languages.join(", ")}`);
    if (dna.length > 0) {
      parts.push(
        `Traveler's Travel DNA — tailor recommendations to this:\n${dna.join(
          "\n"
        )}`
      );
    }
  }

  if (rules && rules.trim()) {
    parts.push(
      `The traveler set these personal rules for you — always respect them:\n${rules.trim()}`
    );
  }

  return parts.join("\n\n");
}

// Tool schemas mirror ActionProposal and PlaceCard exactly so the assembled
// tool_use.input maps straight onto the block types the UI renders.
const TOOLS = [
  {
    name: "propose_itinerary_item",
    description:
      "Propose adding a concrete item to the traveler's itinerary (a reservation, activity, or stop). The app renders a Confirm/Dismiss card; on confirm it inserts an itinerary item.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short title of the item." },
        category: {
          type: "string",
          description:
            "Category, e.g. reservation, activity, dining, transport.",
        },
        location: { type: "string", description: "Where it takes place." },
        day_date: {
          type: "string",
          description: "Optional ISO date, e.g. 2026-03-28.",
        },
        time_label: {
          type: "string",
          description: 'Optional human time label, e.g. "12:45 PM".',
        },
        note: { type: "string", description: "Optional extra note." },
        summary: {
          type: "string",
          description:
            "One-sentence summary shown in the proposal card body, phrased as a question the traveler confirms.",
        },
        confirm_label: {
          type: "string",
          description: 'Optional confirm button label, defaults to "Confirm".',
        },
        dismiss_label: {
          type: "string",
          description: 'Optional dismiss button label, defaults to "Dismiss".',
        },
      },
      required: ["title", "category", "location", "summary"],
    },
  },
  {
    name: "suggest_place",
    description:
      "Surface a rich place card for a specific recommended place. Use for standout recommendations worth showing with an image and details. Always include a `reason` explaining why this specific place fits this specific traveler right now, not just a description of the place.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Place name." },
        image_url: {
          type: "string",
          description:
            "A relevant https://images.unsplash.com/... photo URL. If unsure, use a generic Unsplash travel photo URL. Real place photos come later.",
        },
        category: {
          type: "string",
          description: 'Category, e.g. "Sushi restaurant".',
        },
        rating: {
          type: "number",
          description: "Rating from 0 to 5, e.g. 4.8.",
        },
        price_tier: {
          type: "string",
          description: 'Optional price tier, e.g. "$$$$".',
        },
        description: {
          type: "string",
          description: "One-to-two sentence description of the place itself (what it is, what it's known for).",
        },
        reason: {
          type: "string",
          description:
            "One short sentence explaining why THIS place is being recommended to THIS traveler right now — tie it to their Travel DNA (interests, sliders, dietary needs), their itinerary/current plans, or context from the conversation. E.g. \"Quiet spot near your afternoon stop and matches your interest in temples.\" Do not restate the `description` field or generic praise — be specific to the traveler.",
        },
        duration_label: {
          type: "string",
          description: 'Optional typical duration, e.g. "45-60 min".',
        },
        distance_label: {
          type: "string",
          description: 'Optional distance, e.g. "5 min away".',
        },
        cta_label: {
          type: "string",
          description:
            'Set to any non-empty value (e.g. "true") to show an "Add to Itinerary" button on the card — the app adds this place to the traveler\'s itinerary when tapped. Omit if the place shouldn\'t be directly addable (e.g. a general area or a passing mention).',
        },
      },
      required: ["name", "image_url", "category", "rating", "description", "reason"],
    },
  },
  {
    name: "suggest_quick_replies",
    description:
      "Offer the traveler a short list of concrete, tappable quick-reply options, optionally with a lead-in question or prompt. Call this when the traveler's request is ambiguous, open-ended, or you need clarification before proceeding — instead of guessing, give them 2-5 one-tap options.",
    input_schema: {
      type: "object" as const,
      properties: {
        prompt: {
          type: "string",
          description:
            "Optional short lead-in question or text shown above the options, e.g. 'What kind of place are you in the mood for?'.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "2-5 short, tappable reply options, e.g. [\"Ramen\", \"Sushi\", \"Something local\"].",
        },
      },
      required: ["options"],
    },
  },
];

/** Assemble ordered AiReplyBlock[] from the model's final content blocks. */
function assembleBlocks(
  content: Array<{ type: string; [key: string]: unknown }>
): AiReplyBlock[] {
  const blocks: AiReplyBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      const text = String(block.text ?? "").trim();
      if (text) blocks.push({ kind: "text", text });
    } else if (block.type === "tool_use") {
      const name = block.name as string;
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (name === "propose_itinerary_item") {
        blocks.push({
          kind: "action_proposal",
          proposal: input as unknown as ActionProposal,
        });
      } else if (name === "suggest_place") {
        blocks.push({
          kind: "rich_card",
          card: input as unknown as PlaceCard,
        });
      } else if (name === "suggest_quick_replies") {
        const rawOptions = Array.isArray(input.options) ? input.options : [];
        const options = rawOptions.filter(
          (o): o is string => typeof o === "string" && o.trim().length > 0
        );
        if (options.length > 0) {
          blocks.push({
            kind: "quick_replies",
            quick_replies: {
              prompt:
                typeof input.prompt === "string" && input.prompt.trim()
                  ? input.prompt.trim()
                  : undefined,
              options,
            },
          });
        }
      }
    }
  }
  return blocks;
}

function getStreamErrorMessage(err: unknown): string {
  const fallback =
    "Roameo hit a snag reaching the AI. Please try again in a moment.";

  if (typeof err !== "object" || err === null) return fallback;

  const type = "type" in err ? err.type : undefined;
  const nested = "error" in err ? err.error : undefined;
  const nestedType =
    typeof nested === "object" && nested !== null && "error" in nested
      ? (nested.error as { type?: unknown } | null)?.type
      : undefined;

  if (type === "overloaded_error" || nestedType === "overloaded_error") {
    return "Roameo's AI is temporarily overloaded. Please try again in a moment.";
  }

  return fallback;
}

export async function POST(req: Request): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return new Response(
      JSON.stringify({ type: "error", message: "Invalid request body." }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const system = buildSystemPrompt(body);
  const messages = [
    ...body.history.map((turn) => ({
      role: turn.role,
      content: turn.text,
    })),
    { role: "user" as const, content: body.userText },
  ];

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        const client = getAnthropic();
        const modelStream = client.messages.stream({
          model: CHAT_MODEL,
          max_tokens: 1500,
          thinking: { type: "adaptive" },
          system,
          tools: TOOLS,
          tool_choice: { type: "auto" },
          messages,
        });

        // Stream visible assistant text as it generates.
        modelStream.on("text", (delta: string) => {
          if (delta) send({ type: "text_delta", text: delta });
        });

        const finalMessage = await modelStream.finalMessage();
        const blocks = assembleBlocks(
          finalMessage.content as unknown as Array<{
            type: string;
            [key: string]: unknown;
          }>
        );

        // Guarantee at least one block so the turn is never empty.
        if (blocks.length === 0) {
          blocks.push({
            kind: "text",
            text: "I didn't catch that — could you rephrase?",
          });
        }

        send({ type: "done", blocks });
      } catch (err) {
        const message = getStreamErrorMessage(err);
        console.warn("[api/chat] stream failed", message);
        send({
          type: "error",
          message,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
