import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/seo/JsonLd";
import { SmartImage } from "@/components/ui";
import { listRadarPicks } from "@/lib/db/radar";
import { featuredFirst, featuredPick } from "@/lib/radar/picks";
import { neighbourhoodOf } from "@/lib/radar/candidates";
import { RADAR_NAME, RADAR_PATH, type RadarPick } from "@/lib/radar/types";
import { itemListJsonLd } from "@/lib/seo/list";
import { pageMetadata } from "@/lib/seo/metadata";
import { supabaseAnon } from "@/lib/supabase/anon";

const TITLE = "Under the radar: lesser-known places in Edinburgh";
const DESCRIPTION =
  "Edinburgh places locals love that most visitors miss: a courtyard cafe, a free viewpoint, a tiny bookshop. One new pick a week, each with a reason.";

/** Re-built at most every five minutes. */
export const revalidate = 300;

/**
 * Approved picks via the cookie-less anon client (`places` is public to read).
 * A failed read, or the `radar_*` columns not existing yet, is an empty list:
 * the page then says so and stays out of the index.
 */
const loadPicks = cache(async (): Promise<RadarPick[]> => {
  try {
    return await listRadarPicks(supabaseAnon());
  } catch (err) {
    console.error("[under-the-radar] lookup failed", err);
    return [];
  }
});

export async function generateMetadata(): Promise<Metadata> {
  const picks = await loadPicks();
  return pageMetadata({ title: TITLE, description: DESCRIPTION, path: RADAR_PATH, noindex: picks.length === 0 });
}

function PickCard({ pick, featured }: { pick: RadarPick; featured?: boolean }) {
  const hood = neighbourhoodOf(pick);
  const where = [pick.category, hood === "Unknown" || hood === "Elsewhere" ? null : hood].filter(Boolean).join(" · ");
  return (
    <li>
      <Link
        href={`/place/${pick.id}`}
        className={`flex overflow-hidden rounded-2xl bg-surface-container-lowest shadow-level-1 transition-shadow hover:shadow-md ${
          featured ? "flex-col lg:flex-row" : "flex-row"
        }`}
      >
        {pick.image_url ? (
          <SmartImage
            src={pick.image_url}
            alt={pick.name ?? ""}
            width={featured ? 480 : 128}
            height={featured ? 300 : 128}
            priority={featured}
            className={featured ? "h-48 w-full object-cover lg:h-auto lg:w-72" : "h-auto w-28 shrink-0 object-cover"}
          />
        ) : null}
        <div className="flex flex-col gap-1 p-4">
          {featured ? (
            <span className="w-fit rounded-full bg-primary px-3 py-0.5 text-label-sm font-semibold text-on-primary">
              This week&rsquo;s pick
            </span>
          ) : null}
          <h2 className="text-title-md font-bold text-on-surface">{pick.name}</h2>
          {where ? <p className="text-label-md text-on-surface-variant">{where}</p> : null}
          <p className="text-body-md text-on-surface">{pick.radar_why}</p>
        </div>
      </Link>
    </li>
  );
}

/**
 * "Under the radar": the hand-approved list of lesser-known Edinburgh places,
 * this week's featured pick first. Server-rendered so the HTML holds the real
 * list. Renders an empty state when there are no picks yet.
 */
export default async function UnderTheRadarPage() {
  const picks = await loadPicks();
  const now = new Date();
  const ordered = featuredFirst(picks, now);
  const featured = featuredPick(picks, now);
  const itemList = itemListJsonLd(
    TITLE,
    RADAR_PATH,
    ordered.map((p) => ({ name: p.name ?? "Place", path: `/place/${p.id}` }))
  );

  return (
    <>
      {itemList ? <JsonLd data={itemList} /> : null}
      <div className="flex flex-col pb-6">
        <div className="flex flex-col gap-6 px-4 pt-safe lg:mx-auto lg:w-full lg:max-w-[1200px] lg:px-8">
          <header className="flex flex-col gap-2 pt-5 lg:pt-8">
            <h1 className="text-headline-md font-extrabold tracking-tight text-primary lg:text-[2.25rem] lg:leading-tight">
              {RADAR_NAME}
            </h1>
            <p className="text-body-md text-on-surface-variant lg:max-w-2xl">
              Edinburgh places worth knowing that most visitors miss. Picked by hand, one new one a week.
            </p>
          </header>

          {ordered.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-hairline-strong p-6 text-center text-body-md text-on-surface-variant">
              Nothing here yet. Try{" "}
              <Link href="/explore" className="font-semibold text-primary underline underline-offset-2">
                Explore
              </Link>{" "}
              for places on the map.
            </p>
          ) : (
            <ul className="flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4">
              {ordered.map((pick) => (
                <PickCard key={pick.id} pick={pick} featured={featured?.id === pick.id} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
