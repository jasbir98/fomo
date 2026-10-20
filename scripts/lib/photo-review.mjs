/**
 * photo-review.mjs — asks Claude Haiku 5.5 whether a candidate place photo
 * actually shows the place (its frontage, its room, its food or drink) or is
 * something a venue's share image often is instead: a logo, a text graphic,
 * a poster, a stock photo, a website screenshot. Used by
 * scripts/place-og-images.mjs before a human looks at the contact sheet.
 *
 * Needs ANTHROPIC_API_KEY. One small request per image: low effort,
 * structured JSON out, the image sent as base64 (venue sites often refuse
 * other fetchers), falling back to its URL when it's too big for that.
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";

const MODEL = "claude-haiku-5-5";
// The API caps a base64 image at 5MB of base64 text, i.e. ~3.75MB of bytes.
const MAX_BASE64_BYTES = 3_700_000;

export const VERDICTS = ["venue", "interior", "food_or_drink", "logo_or_text", "poster_or_promo", "stock_or_people", "screenshot_or_collage", "other"];
export const KEEP_VERDICTS = new Set(["venue", "interior", "food_or_drink"]);

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    reason: { type: "string", description: "At most 12 words." },
  },
  required: ["verdict", "reason"],
  additionalProperties: false,
};

const PROMPT = (name, category) =>
  `This image is the link-preview picture from the website of "${name}", a ${category || "place"} in Edinburgh. ` +
  `It may be shown as that place's photo in a city guide app. Classify what it shows:\n` +
  `- venue: the outside of the place, or a recognisable view of it\n` +
  `- interior: inside the place (bar, room, shop floor, gallery space)\n` +
  `- food_or_drink: what it serves, plated or poured\n` +
  `- logo_or_text: mostly a logo, wordmark, sign-up banner or text on a plain background\n` +
  `- poster_or_promo: an event poster, offer graphic or advert with large text over it\n` +
  `- stock_or_people: generic stock imagery or posed people with nothing of the place\n` +
  `- screenshot_or_collage: a website/app screenshot or a grid of several images\n` +
  `- other: anything else\n` +
  `Small text in a real photo is fine; judge what a visitor would see first.`;

let client;

/** { verdict, keep, reason } for one image. Throws on an API error. */
export async function reviewPhoto({ bytes, mediaType, url, name, category }) {
  client ??= new Anthropic();
  const source =
    bytes && bytes.length <= MAX_BASE64_BYTES
      ? { type: "base64", media_type: mediaType, data: Buffer.from(bytes).toString("base64") }
      : { type: "url", url };
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 1024,
    output_config: { effort: "low", format: jsonSchemaOutputFormat(SCHEMA) },
    messages: [{ role: "user", content: [{ type: "image", source }, { type: "text", text: PROMPT(name, category) }] }],
  });
  if (response.stop_reason === "refusal") return { verdict: "other", keep: false, reason: "model declined to classify" };
  const out = response.parsed_output;
  if (!out) return { verdict: "other", keep: false, reason: "no verdict returned" };
  return { verdict: out.verdict, keep: KEEP_VERDICTS.has(out.verdict), reason: out.reason };
}
