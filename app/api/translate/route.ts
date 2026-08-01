/**
 * Roameo Translator — real Claude-powered translation (server-only).
 *
 * Single POST route, two request shapes (branch on `kind`):
 *   TEXT:  { kind: "text",  text, sourceLang, targetLang }
 *          -> { sourceText, translation, pronunciation, note? }
 *   PHOTO: { kind: "photo", imageBase64, mediaType, targetLang }
 *          -> { items: { original, translation, pronunciation? }[], summary? }
 *
 * Uses structured outputs (`output_config.format`) so the client always gets
 * a predictable JSON shape back instead of parsing free text. The API key
 * lives only in the server env (via getAnthropic()); it never reaches the
 * client bundle — this file must never be imported from a "use client"
 * component.
 */
import "server-only";
import { getAnthropic, CHAT_MODEL } from "@/lib/ai/anthropic";
import type {
  TranslateRequest,
  TranslateTextResult,
  TranslatePhotoResult,
} from "@/lib/ai/translate-types";

export const runtime = "nodejs";

const SYSTEM_PROMPT =
  "You are a travel translator. Translate accurately and naturally; include a pronunciation guide (romaji/pinyin/etc.) when the target language uses a non-Latin script.";

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

const TEXT_SCHEMA: Record<string, unknown> = {
  type: "object",
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
  additionalProperties: false,
};

const PHOTO_SCHEMA: Record<string, unknown> = {
  type: "object",
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
        additionalProperties: false,
      },
    },
    summary: {
      type: "string",
      description:
        'Optional one-sentence summary of what the image shows (e.g. "A ramen shop menu with 6 items"). Omit if not useful.',
    },
  },
  required: ["items"],
  additionalProperties: false,
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

/** Pull the first text content block's text out of a Claude response. */
function extractJsonText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    if (block?.type === "text" && typeof block.text === "string") {
      return block.text;
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

  const client = getAnthropic();

  try {
    if (body.kind === "text") {
      const text = body.text?.trim();
      if (!text) return jsonError("Missing text to translate.", 400);
      const sourceLang = body.sourceLang?.trim() || "English";
      const targetLang = body.targetLang?.trim() || "the local language";

      const message = await client.messages.create({
        model: CHAT_MODEL,
        max_tokens: 2048,
        thinking: { type: "adaptive" },
        system: SYSTEM_PROMPT,
        output_config: {
          format: { type: "json_schema", schema: TEXT_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: `Translate the following text from ${sourceLang} to ${targetLang}.\n\nText:\n"""${text}"""`,
          },
        ],
      });

      const raw = extractJsonText(message.content);
      if (!raw) return jsonError("The translator returned an empty response.");
      const parsed = JSON.parse(raw) as TranslateTextResult;
      return jsonResponse(parsed);
    }

    if (body.kind === "photo") {
      if (!body.imageBase64) return jsonError("Missing image data.", 400);
      if (!body.mediaType || !isAllowedImageType(body.mediaType)) {
        return jsonError("Unsupported image type.", 400);
      }
      const targetLang = body.targetLang?.trim() || "the local language";

      const message = await client.messages.create({
        model: CHAT_MODEL,
        max_tokens: 2048,
        thinking: { type: "adaptive" },
        system: SYSTEM_PROMPT,
        output_config: {
          format: { type: "json_schema", schema: PHOTO_SCHEMA },
        },
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

      const raw = extractJsonText(message.content);
      if (!raw) return jsonError("The translator returned an empty response.");
      const parsed = JSON.parse(raw) as TranslatePhotoResult;
      return jsonResponse(parsed);
    }

    return jsonError("Unknown request kind.", 400);
  } catch (err) {
    console.error("[api/translate] failed", err);
    return jsonError("Roameo hit a snag translating that. Please try again.");
  }
}
