/**
 * Shared server-only Anthropic client for Roameo's AI features.
 *
 * IMPORTANT: This module MUST only ever be imported from server-side code
 * (Next.js Route Handlers under app/api/*). It reads ANTHROPIC_API_KEY from
 * the server environment. Never import it into a "use client" component — the
 * key must never reach the browser bundle.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/** The model Roameo uses for all chat + translation. */
export const CHAT_MODEL = "claude-sonnet-5";

let client: Anthropic | null = null;

/**
 * Returns a lazily-constructed singleton Anthropic client. The constructor
 * reads ANTHROPIC_API_KEY from process.env automatically.
 */
export function getAnthropic(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}
