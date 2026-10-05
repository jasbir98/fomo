import type { ReactNode } from "react";

/**
 * Minimal inline markdown for assistant/user chat text — no markdown library
 * in this project. Handles `**bold**` and `*italic*` only, splitting on a
 * single regex pass. Bold is matched before italic in the alternation so
 * `**x**` never gets mis-split into two italic halves.
 */
export function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}
