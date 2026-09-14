/**
 * Shared server-only Anthropic-SDK client for Fomo's AI features.
 *
 * IMPORTANT: This module MUST only ever be imported from server-side code
 * (Next.js Route Handlers under app/api/*). It reads API keys from the server
 * environment. Never import it into a "use client" component — no key may ever
 * reach the browser bundle.
 *
 * Provider: DeepSeek whenever DEEPSEEK_API_KEY is set, otherwise Anthropic.
 * DeepSeek exposes an Anthropic-compatible Messages API, so the same SDK and
 * the same request shapes work against either — only the client's key, base
 * URL, and model differ.
 *
 * Verified live against DeepSeek on 2026-09-13, using the exact request shapes
 * this app sends:
 *   - chat (app/api/chat): messages.stream with `thinking: { type: "adaptive" }`,
 *     custom tools, and `tool_choice: { type: "auto" }` — streams text and
 *     returns real tool_use blocks.
 *   - translator (app/api/translate): base64 image input — read and translated
 *     sign text correctly.
 *
 * If a future caller forces a specific tool (`tool_choice: { type: "tool" }`),
 * it must also pass `thinking: { type: "disabled" }`: DeepSeek's thinking mode
 * rejects a forced tool_choice with a 400. Nothing in the app does this today.
 * (The scraper pipelines hit that, and two more quirks; see scraper/llm_client.py.)
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic";

const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();

/**
 * The model Fomo uses for all chat + translation.
 *
 * Set explicitly per provider rather than relying on DeepSeek's alias mapping:
 * DeepSeek silently serves Claude Sonnet/Haiku names with `deepseek-flash`,
 * which works but leaves logs and debugging naming the wrong model.
 * `deepseek-flash` is DeepSeek's official ID for V4.1 Flash — not
 * "deepseek-v4.1-flash", which is a third-party platform ID.
 */
export const CHAT_MODEL = deepseekKey ? "deepseek-flash" : "claude-sonnet-5";

let client: Anthropic | null = null;

/** Returns a lazily-constructed singleton client for the active provider. */
export function getAnthropic(): Anthropic {
  if (!client) {
    client = deepseekKey
      ? new Anthropic({ apiKey: deepseekKey, baseURL: DEEPSEEK_BASE_URL })
      : // Reads ANTHROPIC_API_KEY from process.env automatically.
        new Anthropic();
  }
  return client;
}
