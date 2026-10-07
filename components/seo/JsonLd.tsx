import { serializeJsonLd } from "@/lib/seo/jsonld";

/** Inline structured data for search engines. A server component: the script is in the first HTML. */
export function JsonLd({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
