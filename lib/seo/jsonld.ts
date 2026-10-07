/**
 * Serialises a JSON-LD object for an inline <script type="application/ld+json">.
 * `<` is escaped to its unicode form so a title or description containing
 * "</script>" (these come from scraped rows) can never close the tag early.
 * See node_modules/next/dist/docs/01-app/02-guides/json-ld.md.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
