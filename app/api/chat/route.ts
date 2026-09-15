/**
 * Ask Fomo — streaming chat grounded in Fomo's own Edinburgh catalogue
 * (server-only).
 *
 * Each request builds a compact catalogue of live happenings (deals, free
 * things, festivals) and the next week's events, puts it in the system
 * prompt, and gives the model one way to recommend something concrete:
 * `show_items` with catalogue ids. The route resolves those ids into real
 * cards (title, price, when, where, link), so the model never supplies a
 * venue, price, photo or rating of its own.
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
import { supabaseServer } from "@/lib/supabase/server";
import { consumeRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { CITY } from "@/lib/city";
import { listLiveHappenings } from "@/lib/db/happenings";
import { listUpcomingEvents } from "@/lib/db/events";
import { nextOccurrence, normalizeRecurrence, happeningHasEnded } from "@/lib/happenings/occurrence";
import { eligibilityLine, happeningTimeLabel, recurrencePatternLabel, savingBadgeLabel } from "@/lib/happenings/format";
import { parseWhoGroups, WHO_GROUP_LABEL, type DealWhoGroup } from "@/lib/happenings/groups";
import { formatEventPrice, formatEventWhen, eventHasEnded } from "@/lib/events/format";
import type { AiReplyBlock, ChatItem } from "@/lib/fomo-ai";
import type { CardSubjectType } from "@/lib/types";
import type { Db } from "@/lib/supabase/types";

export const runtime = "nodejs";

// Pre-public-deploy abuse guards (rate limiting + input caps) — see
// lib/rate-limit.ts and supabase/add_rate_limits.sql. Two windows checked
// per request: a short burst cap and a generous daily cap.
const CHAT_RATE_LIMIT_BURST = { limit: 30, windowSeconds: 10 * 60 };
const CHAT_RATE_LIMIT_DAILY = { limit: 150, windowSeconds: 24 * 60 * 60 };

/** Matches the client's own cap (app/(shell)/fomo/page.tsx sends 12) but enforced here too, since this route has no way to know a request came from that UI. */
const MAX_HISTORY_TURNS = 20;
const MAX_MESSAGE_CHARS = 2000;

/** How far ahead the catalogue looks, and how many provider events it carries. */
const CATALOGUE_DAYS = 7;
const MAX_CATALOGUE_EVENTS = 60;
const MAX_ITEMS_PER_REPLY = 4;

type HistoryTurn = { role: "user" | "assistant"; text: string };

/** Set when the client opened chat from a card's "Ask Fomo" action, carrying what the card was about. */
interface ChatSeedContext {
  type: CardSubjectType;
  name: string;
  city: string | null;
}

interface ChatRequestBody {
  history: HistoryTurn[];
  userText: string;
  seed?: ChatSeedContext | null;
}

interface Catalogue {
  /** One pipe-separated line per item, for the system prompt. */
  lines: string[];
  /** Catalogue id ("H:<uuid>" / "E:<uuid>") → the card the client renders. */
  items: Map<string, ChatItem>;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ type: "error", message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Pipe-separated fields can't contain a pipe or a newline. */
function field(value: string | null | undefined, fallback: string): string {
  const clean = (value ?? "").replace(/[|\n]+/g, " ").trim();
  return clean || fallback;
}

async function buildCatalogue(db: Db, now: Date): Promise<Catalogue> {
  const to = new Date(now.getTime() + CATALOGUE_DAYS * 86_400_000);
  const [happenings, events] = await Promise.all([
    listLiveHappenings(db, CITY),
    listUpcomingEvents(db, {
      destination: CITY.name,
      from: now.toISOString(),
      to: to.toISOString(),
      limit: MAX_CATALOGUE_EVENTS,
    }),
  ]);

  const lines: string[] = [];
  const items = new Map<string, ChatItem>();

  for (const h of happenings) {
    const occurrence = nextOccurrence(h, now, to, CITY.timezone);
    if (!occurrence) continue;
    if (happeningHasEnded(h, now, CITY.timezone)) continue; // final "no ended items ever leave an API" guard
    const when =
      happeningTimeLabel(occurrence) ?? recurrencePatternLabel(normalizeRecurrence(h.recurrence)) ?? "any time";
    const where = h.venue_name ?? h.district ?? null;
    const badge = h.is_free ? "Free" : savingBadgeLabel(h);
    const key = `H:${h.id}`;
    lines.push(
      [
        key,
        field(h.title, "Untitled"),
        h.kind,
        field(badge, "price varies"),
        field(when, "any time"),
        field(where, CITY.name),
        field(eligibilityLine(h), "anyone"),
        field(h.summary?.slice(0, 100), ""),
      ].join(" | ")
    );
    items.set(key, {
      kind: "happening",
      id: h.id,
      title: h.title,
      subtitle: [when, where].filter(Boolean).join(" · ") || null,
      badge,
      image_url: h.image_url,
      href: `/happening/${h.id}`,
    });
  }

  for (const e of events) {
    if (eventHasEnded(e, now)) continue; // final "no ended items ever leave an API" guard
    const key = `E:${e.id}`;
    const when = formatEventWhen(e.starts_at);
    const price = formatEventPrice(e) || null;
    lines.push(
      [
        key,
        field(e.name, "Untitled"),
        "event",
        field(price, "price unknown"),
        field(when, "date unknown"),
        field(e.venue_name, CITY.name),
        field(e.category, ""),
      ].join(" | ")
    );
    items.set(key, {
      kind: "event",
      id: e.id,
      title: e.name,
      subtitle: [when, e.venue_name].filter(Boolean).join(" · ") || null,
      badge: price,
      image_url: e.image_url,
      href: `/event/${e.id}`,
    });
  }

  return { lines, items };
}

function buildSystemPrompt(
  catalogue: Catalogue,
  now: Date,
  who: DealWhoGroup[],
  seed: ChatSeedContext | null | undefined
): string {
  const today = new Intl.DateTimeFormat("en-GB", {
    timeZone: CITY.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);

  const parts: string[] = [
    `You are Fomo, a friend in ${CITY.name} who always knows what's on and what's free, cheap or discounted right now. It is ${today} in ${CITY.name}. Warm, direct, UK English.`,
    "Keep replies short: 1-3 sentences, answer first, no preamble or caveats nobody asked for.",
    `Ground every recommendation in the CATALOGUE below — Fomo's verified list of live deals, free things, festivals and this week's events. When you recommend something concrete, call show_items with its catalogue ids (up to ${MAX_ITEMS_PER_REPLY}, best first) and keep your text to a short lead-in; the app shows each card with its price, time and place. Never state a price, date, time, venue or discount that isn't in the catalogue, and never invent places or events. General ${CITY.name} knowledge (neighbourhoods, getting around, what an area is like) is fine without ids.`,
    "If nothing in the catalogue fits, say so plainly and offer the closest match. If a request is too vague to act on, call suggest_quick_replies with 2-4 concrete options instead of guessing.",
  ];

  if (who.length > 0) {
    parts.push(
      `This person qualifies for: ${who.map((g) => WHO_GROUP_LABEL[g]).join(", ")}. Prefer offers they can use and mention when they qualify. Don't push concessions for other groups unless asked.`
    );
  } else {
    parts.push(
      "You don't know which concessions this person qualifies for. When you suggest a restricted offer (students, EH residents, under 26, over 60), say who it's for."
    );
  }

  if (seed) {
    parts.push(
      `They opened this chat from "${seed.name}" (${seed.type}). Assume their first message is about it unless they clearly change the subject.`
    );
  }

  parts.push(
    `CATALOGUE (id | title | kind | price or saving | when | where | who it's for or category | summary):\n${
      catalogue.lines.length > 0 ? catalogue.lines.join("\n") : "(nothing live right now)"
    }`
  );

  return parts.join("\n\n");
}

const TOOLS = [
  {
    name: "show_items",
    description: `Show cards for the catalogue items you are recommending. Pass ids exactly as written in the CATALOGUE (e.g. "H:…" or "E:…"), best first, at most ${MAX_ITEMS_PER_REPLY}.`,
    input_schema: {
      type: "object" as const,
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Catalogue ids, best first.",
        },
        reason: {
          type: "string",
          description: "Optional short line on why these, shown above the cards.",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "suggest_quick_replies",
    description:
      "Offer 2-4 short, tappable reply options, optionally with a lead-in question. Use when the request is too vague to act on well, instead of guessing.",
    input_schema: {
      type: "object" as const,
      properties: {
        prompt: {
          type: "string",
          description: "Optional short lead-in question shown above the options.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: '2-4 short options, e.g. ["Free", "Under £10", "Treat myself"].',
        },
      },
      required: ["options"],
    },
  },
];

/** Assemble ordered AiReplyBlock[] from the model's final content blocks, resolving show_items ids against the catalogue (unknown ids are dropped). */
function assembleBlocks(
  content: Array<{ type: string; [key: string]: unknown }>,
  catalogue: Catalogue
): AiReplyBlock[] {
  const blocks: AiReplyBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      const text = String(block.text ?? "").trim();
      if (text) blocks.push({ kind: "text", text });
    } else if (block.type === "tool_use") {
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (block.name === "show_items") {
        const ids = Array.isArray(input.ids) ? input.ids : [];
        const seen = new Set<string>();
        const items: ChatItem[] = [];
        for (const id of ids) {
          if (typeof id !== "string") continue;
          const key = id.trim();
          const item = catalogue.items.get(key);
          if (!item || seen.has(key)) continue;
          seen.add(key);
          items.push(item);
          if (items.length >= MAX_ITEMS_PER_REPLY) break;
        }
        if (items.length > 0) {
          blocks.push({
            kind: "items",
            reason: typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : undefined,
            items,
          });
        }
      } else if (block.name === "suggest_quick_replies") {
        const rawOptions = Array.isArray(input.options) ? input.options : [];
        const options = rawOptions.filter((o): o is string => typeof o === "string" && o.trim().length > 0);
        if (options.length > 0) {
          blocks.push({
            kind: "quick_replies",
            quick_replies: {
              prompt: typeof input.prompt === "string" && input.prompt.trim() ? input.prompt.trim() : undefined,
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
  const fallback = "Fomo hit a snag reaching the AI. Please try again in a moment.";

  if (typeof err !== "object" || err === null) return fallback;

  const type = "type" in err ? err.type : undefined;
  const nested = "error" in err ? err.error : undefined;
  const nestedType =
    typeof nested === "object" && nested !== null && "error" in nested
      ? (nested.error as { type?: unknown } | null)?.type
      : undefined;

  if (type === "overloaded_error" || nestedType === "overloaded_error") {
    return "Fomo is temporarily overloaded. Please try again in a moment.";
  }

  return fallback;
}

export async function POST(req: Request): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return jsonError("Invalid request body.", 400);
  }

  if (typeof body.userText !== "string" || !body.userText.trim()) {
    return jsonError("Missing message text.", 400);
  }
  if (body.userText.length > MAX_MESSAGE_CHARS) {
    return jsonError(`Message is too long (max ${MAX_MESSAGE_CHARS} characters).`, 400);
  }
  if (!Array.isArray(body.history)) {
    return jsonError("Invalid request body.", 400);
  }

  // Drop malformed entries (wrong shape/types) and cap to the most recent
  // turns — a defensive re-application of the client's own cap, since a
  // direct API call bypasses app/(shell)/fomo/page.tsx entirely.
  const history: HistoryTurn[] = body.history
    .filter(
      (turn): turn is HistoryTurn =>
        !!turn &&
        typeof turn === "object" &&
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.text === "string"
    )
    .slice(-MAX_HISTORY_TURNS);

  // Rate limit — burst window first, then daily; either exceeded denies the
  // request. Fails open (lets the request through) until
  // supabase/add_rate_limits.sql has been run — see lib/rate-limit.ts.
  const db = await supabaseServer();
  const burst = await consumeRateLimit(db, "chat:burst", CHAT_RATE_LIMIT_BURST);
  if (!burst.allowed) return rateLimitedResponse(burst);
  const daily = await consumeRateLimit(db, "chat:day", CHAT_RATE_LIMIT_DAILY);
  if (!daily.allowed) return rateLimitedResponse(daily);

  const {
    data: { user },
  } = await db.auth.getUser();
  const who = parseWhoGroups(user?.user_metadata);

  const now = new Date();
  let catalogue: Catalogue;
  try {
    catalogue = await buildCatalogue(db, now);
  } catch (err) {
    // Chat still answers general questions; the prompt says nothing is live.
    console.error("[api/chat] catalogue build failed", err);
    catalogue = { lines: [], items: new Map() };
  }

  const system = buildSystemPrompt(catalogue, now, who, body.seed);
  const messages = [
    ...history.map((turn) => ({ role: turn.role, content: turn.text })),
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
          finalMessage.content as unknown as Array<{ type: string; [key: string]: unknown }>,
          catalogue
        );

        // Guarantee at least one block so the turn is never empty.
        if (blocks.length === 0) {
          blocks.push({ kind: "text", text: "I didn't catch that — could you rephrase?" });
        }

        send({ type: "done", blocks });
      } catch (err) {
        const message = getStreamErrorMessage(err);
        console.warn("[api/chat] stream failed", message);
        send({ type: "error", message });
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
