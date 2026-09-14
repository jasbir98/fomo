/**
 * Fomo Translator — real Claude-powered translation (server-only).
 *
 * Single POST route, two request shapes (branch on `kind`):
 *   TEXT:  { kind: "text",  text, sourceLang, targetLang }
 *          -> { sourceText, translation, pronunciation, note? }
 *   PHOTO: { kind: "photo", imageBase64, mediaType, targetLang }
 *          -> { items: { original, translation, pronunciation? }[], summary? }
 *
 * Structured output is extracted via a FORCED TOOL CALL, not
 * `output_config.format` — DeepSeek's Anthropic-compatible endpoint accepts
 * `output_config.format: { type: "json_schema", ... }` without error but
 * silently ignores it, replying with ordinary prose (verified live
 * 2026-09-14: the model happily answers in a `text` block instead of
 * matching the schema, so `JSON.parse()` on it throws and every translate
 * call 500s). A forced `tool_choice: { type: "tool", name: ... }` reliably
 * returns the shape as the tool's `input` on both providers, matching the
 * pattern scraper/llm_client.py already uses for structured output. Forced
 * tool_choice requires `thinking: { type: "disabled" }` — DeepSeek's
 * thinking mode rejects a forced tool_choice with a 400 (see
 * scraper/llm_client.py quirk 2).
 *
 * The API key lives only in the server env (via getAnthropic()); it never
 * reaches the client bundle — this file must never be imported from a "use
 * client" component.
 */
import "server-only";
import { getAnthropic, CHAT_MODEL } from "@/lib/ai/anthropic";
import { supabaseServer } from "@/lib/supabase/server";
import { consumeRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import type {
  TranslateRequest,
  TranslateTextResult,
  TranslatePhotoResult,
} from "@/lib/ai/translate-types";

export const runtime = "nodejs";

const SYSTEM_PROMPT =
  "You are a travel translator. Translate accurately and naturally; include a pronunciation guide (romaji/pinyin/etc.) when the target language uses a non-Latin script.";

// Pre-public-deploy abuse guards (rate limiting + input caps) — see
// lib/rate-limit.ts and supabase/add_rate_limits.sql. Two windows checked
// per request: a short burst cap and a generous daily cap.
const TRANSLATE_RATE_LIMIT_BURST = { limit: 40, windowSeconds: 10 * 60 };
const TRANSLATE_RATE_LIMIT_DAILY = { limit: 200, windowSeconds: 24 * 60 * 60 };

const MAX_TEXT_CHARS = 2000;
// Decoded bytes, not base64-string length (base64 runs ~33% larger than the
// bytes it encodes) — checked via Buffer.byteLength(str, "base64") below.
// The client (app/fomo/translator/page.tsx, via lib/image/downscale.ts)
// downscales to a longest side of 1600px / ~1.5 MB before encoding, so this
// is a hard backstop, not the primary size control. Kept well under Vercel
// Hobby's ~4.5 MB request-body limit once base64-inflated (3 MB decoded ->
// ~4 MB base64).
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;
type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

function isAllowedImageType(value: string): value is AllowedImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(value);
}

// Tool name forced via tool_choice — see the file header on why this replaces
// output_config.format. "submit_" prefix mirrors scraper/llm_client.py's
// submit-tool convention for structured output.
const SUBMIT_TEXT_TOOL = "submit_translation";
const SUBMIT_PHOTO_TOOL = "submit_photo_translation";

const TEXT_TOOL = {
  name: SUBMIT_TEXT_TOOL,
  description: "Submit the translation result.",
  input_schema: {
    type: "object" as const,
    properties: {
      sourceText: {
        type: "string",
        description: "The original source text, echoed back verbatim.",
      },
      translation: {
        type: "string",
        description: "The translation of sourceText into the target language.",
      },
      pronunciation: {
        type: "string",
        description:
          "Romanized/phonetic pronunciation guide for the translation (e.g. romaji, pinyin). Empty string if the target language already uses Latin script and no romanization is needed.",
      },
      note: {
        type: "string",
        description:
          "Optional short usage or cultural note about the phrase. Omit if there is nothing useful to add.",
      },
    },
    required: ["sourceText", "translation", "pronunciation"],
  },
};

const PHOTO_TOOL = {
  name: SUBMIT_PHOTO_TOOL,
  description: "Submit the detected + translated text from the photo.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        description:
          "One entry per distinct line or phrase of text detected in the image (e.g. each menu line or sign phrase), in the order they appear.",
        items: {
          type: "object",
          properties: {
            original: {
              type: "string",
              description: "The original text exactly as detected in the image.",
            },
            translation: {
              type: "string",
              description: "The translation of that text into the target language.",
            },
            pronunciation: {
              type: "string",
              description:
                "Romanized/phonetic pronunciation guide. Empty string if not applicable.",
            },
          },
          required: ["original", "translation"],
        },
      },
      summary: {
        type: "string",
        description:
          'Optional one-sentence summary of what the image shows (e.g. "A ramen shop menu with 6 items"). Omit if not useful.',
      },
    },
    required: ["items"],
  },
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

/** Pull the forced tool call's `input` out of a Claude/DeepSeek response. */
function extractToolInput(content: unknown, toolName: string): Record<string, unknown> | null {
  if (!Array.isArray(content)) return null;
  for (const block of content as Array<{ type?: unknown; name?: unknown; input?: unknown }>) {
    if (block?.type === "tool_use" && block.name === toolName && block.input && typeof block.input === "object") {
      return block.input as Record<string, unknown>;
    }
  }
  return null;
}

export async function POST(req: Request): Promise<Response> {
  let body: TranslateRequest;
  try {
    body = (await req.json()) as TranslateRequest;
  } catch {
    return jsonError("Invalid request body.", 400);
  }

  if (body?.kind !== "text" && body?.kind !== "photo") {
    return jsonError("Unknown request kind.", 400);
  }

  // Rate limit — burst window first, then daily; either exceeded denies the
  // request. Fails open (lets the request through) until
  // supabase/add_rate_limits.sql has been run — see lib/rate-limit.ts.
  const db = await supabaseServer();
  const burst = await consumeRateLimit(db, "translate:burst", TRANSLATE_RATE_LIMIT_BURST);
  if (!burst.allowed) return rateLimitedResponse(burst);
  const daily = await consumeRateLimit(db, "translate:day", TRANSLATE_RATE_LIMIT_DAILY);
  if (!daily.allowed) return rateLimitedResponse(daily);

  const client = getAnthropic();

  try {
    if (body.kind === "text") {
      if (typeof body.text !== "string") return jsonError("Missing text to translate.", 400);
      const text = body.text.trim();
      if (!text) return jsonError("Missing text to translate.", 400);
      if (text.length > MAX_TEXT_CHARS) {
        return jsonError(`Text is too long (max ${MAX_TEXT_CHARS} characters).`, 400);
      }
      const sourceLang = body.sourceLang?.trim() || "English";
      const targetLang = body.targetLang?.trim() || "the local language";

      const message = await client.messages.create({
        model: CHAT_MODEL,
        max_tokens: 2048,
        thinking: { type: "disabled" },
        system: SYSTEM_PROMPT,
        tools: [TEXT_TOOL],
        tool_choice: { type: "tool", name: SUBMIT_TEXT_TOOL },
        messages: [
          {
            role: "user",
            content: `Translate the following text from ${sourceLang} to ${targetLang}.\n\nText:\n"""${text}"""`,
          },
        ],
      });

      const parsed = extractToolInput(message.content, SUBMIT_TEXT_TOOL);
      if (!parsed) return jsonError("The translator returned an empty response.");
      return jsonResponse(parsed as unknown as TranslateTextResult);
    }

    if (body.kind === "photo") {
      if (typeof body.imageBase64 !== "string" || !body.imageBase64) {
        return jsonError("Missing image data.", 400);
      }
      if (typeof body.mediaType !== "string" || !isAllowedImageType(body.mediaType)) {
        return jsonError("Unsupported image type.", 400);
      }
      // Decoded byte length, not the base64 string's own length — see the
      // MAX_IMAGE_BYTES comment up top.
      const decodedBytes = Buffer.byteLength(body.imageBase64, "base64");
      if (decodedBytes > MAX_IMAGE_BYTES) {
        return jsonError(
          `That photo is too large (max ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB). Try a smaller photo.`,
          413
        );
      }
      const targetLang = body.targetLang?.trim() || "the local language";

      const message = await client.messages.create({
        model: CHAT_MODEL,
        max_tokens: 2048,
        thinking: { type: "disabled" },
        system: SYSTEM_PROMPT,
        tools: [PHOTO_TOOL],
        tool_choice: { type: "tool", name: SUBMIT_PHOTO_TOOL },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: body.mediaType,
                  data: body.imageBase64,
                },
              },
              {
                type: "text",
                text: `This photo shows a menu or sign. Detect every distinct line or phrase of text in it and translate each into ${targetLang}. Return one item per detected phrase, in the order they appear.`,
              },
            ],
          },
        ],
      });

      const parsed = extractToolInput(message.content, SUBMIT_PHOTO_TOOL);
      if (!parsed) return jsonError("The translator returned an empty response.");
      return jsonResponse(parsed as unknown as TranslatePhotoResult);
    }

    return jsonError("Unknown request kind.", 400);
  } catch (err) {
    console.error("[api/translate] failed", err);
    return jsonError("Fomo hit a snag translating that. Please try again.");
  }
}
