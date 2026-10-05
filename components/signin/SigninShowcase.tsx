import Image from "next/image";
import { Icon } from "@/components/ui";

/**
 * Desktop-only (lg+) showcase pieces for app/signin/page.tsx's left panel.
 * Everything here is presentational and decorative: the photos are the app's
 * own bundled Edinburgh category images, the example cards are static
 * illustrations (not live listings), and the sign-in page's own copy carries
 * all the meaning. The page mounts the photo pieces only once `useIsDesktop()`
 * is true (inside `hidden lg:*` wrappers too), so phones never fetch them.
 */

const PHOTO_DIR = "/defaults/happenings";

type Tile = { img: string; ratio: string };

// Three columns of rounded photo tiles. Edinburgh street scenes (Old Town
// tours, Grassmarket festival, Arthur's Seat, the cobbled "other") lead; the
// category shots (gigs, cinema, comedy, food…) fill around them.
const COLUMNS: Tile[][] = [
  [
    { img: "outdoors", ratio: "aspect-[4/5]" },
    { img: "comedy", ratio: "aspect-square" },
    { img: "tours", ratio: "aspect-[4/5]" },
    { img: "music", ratio: "aspect-square" },
  ],
  [
    { img: "festival", ratio: "aspect-square" },
    { img: "other", ratio: "aspect-[4/5]" },
    { img: "food", ratio: "aspect-square" },
    { img: "museum", ratio: "aspect-[4/5]" },
  ],
  [
    { img: "nightlife", ratio: "aspect-[4/5]" },
    { img: "cinema", ratio: "aspect-square" },
    { img: "arts", ratio: "aspect-[4/5]" },
    { img: "sports", ratio: "aspect-square" },
  ],
];

const COLUMN_OFFSETS = ["-mt-16", "mt-4", "-mt-32"];
const COLUMN_DRIFT = ["signin-drift-a", "signin-drift-b", "signin-drift-a"];

/** Full-bleed tilted photo collage + navy wash. Absolutely positioned: drop
 *  it as the first child of a `relative overflow-hidden` panel. */
export function SigninCollage() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          .signin-drift-a { animation: signin-drift-a 38s ease-in-out infinite alternate; }
          .signin-drift-b { animation: signin-drift-b 44s ease-in-out infinite alternate; }
          .signin-card-bob { animation: signin-card-bob 6s ease-in-out infinite; }
          .signin-card-bob-2 { animation-delay: -2s; }
          .signin-card-bob-3 { animation-delay: -4s; }
        }
        @keyframes signin-drift-a { from { transform: translateY(0); } to { transform: translateY(-28px); } }
        @keyframes signin-drift-b { from { transform: translateY(-18px); } to { transform: translateY(14px); } }
        @keyframes signin-card-bob { 0%, 100% { translate: 0 0; } 50% { translate: 0 -6px; } }
      `}</style>
      <div className="absolute -inset-x-[18%] -inset-y-[22%] rotate-[-9deg]">
        <div className="grid h-full grid-cols-3 gap-4">
          {COLUMNS.map((col, ci) => (
            <div key={ci} className={`flex flex-col gap-4 ${COLUMN_OFFSETS[ci]}`}>
              <div className={`flex flex-col gap-4 ${COLUMN_DRIFT[ci]}`}>
                {col.map((tile) => (
                  <div
                    key={tile.img}
                    className={`relative w-full overflow-hidden rounded-3xl bg-primary-container ${tile.ratio}`}
                  >
                    <Image
                      src={`${PHOTO_DIR}/${tile.img}.webp`}
                      alt=""
                      fill
                      sizes="(min-width: 1024px) 24vw, 0px"
                      quality={70}
                      className="object-cover"
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* Navy wash: dense under the copy on the left, letting the photos
          breathe on the right. Brand colour, not black, so it stays Fomo. */}
      <div className="absolute inset-0 bg-gradient-to-r from-primary/95 from-[5%] via-primary/85 via-[62%] to-primary/30" />
      <div className="absolute inset-0 bg-gradient-to-t from-primary/80 via-transparent to-primary/50" />
      <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-brand-orange/25 blur-3xl" />
    </div>
  );
}

const VALUE_PROPS = [
  {
    icon: "sell",
    title: "Free and cheap, every day",
    body: "Gigs, comedy, cinema, food and days out under £10, all in one place.",
  },
  {
    icon: "school",
    title: "Student and EH-resident deals",
    body: "Real discounts for students and Edinburgh locals, without the hunt.",
  },
  {
    icon: "notifications_active",
    title: "Fomo Friday alerts",
    body: "Save things and get a weekend round-up. Never miss the £4 cinema night again.",
  },
];

export function SigninValueProps() {
  return (
    <ul className="mt-7 flex max-w-md flex-col gap-5">
      {VALUE_PROPS.map((p) => (
        <li key={p.icon} className="flex items-start gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/12 text-brand-orange ring-1 ring-white/15 backdrop-blur-sm">
            <Icon name={p.icon} filled size={22} />
          </span>
          <div>
            <p className="text-label-lg font-semibold text-on-primary">{p.title}</p>
            <p className="mt-0.5 text-body-md text-on-primary/70">{p.body}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

type ExampleCard = {
  img: string;
  title: string;
  meta: string;
  pill: string;
  pillClass: string;
  className: string;
};

// Generic, clearly illustrative examples: no venue names, no dates.
const EXAMPLES: ExampleCard[] = [
  {
    img: "comedy",
    title: "Comedy night",
    meta: "Tonight · Old Town",
    pill: "Free",
    pillClass: "bg-emerald-100 text-emerald-800",
    className: "signin-card-bob rotate-[-2.5deg]",
  },
  {
    img: "cinema",
    title: "Cinema screening",
    meta: "This weekend",
    pill: "£4 tickets",
    pillClass: "bg-orange-100 text-brand-orange-ink",
    className: "signin-card-bob signin-card-bob-2 ml-14 rotate-[1.5deg]",
  },
  {
    img: "food",
    title: "Student brunch",
    meta: "Every Saturday",
    pill: "20% off · Students",
    pillClass: "bg-sky-100 text-sky-800",
    className: "signin-card-bob signin-card-bob-3 ml-5 rotate-[-1deg]",
  },
];

/** Three small floating "deal card" illustrations. */
export function SigninExampleCards() {
  return (
    <div aria-hidden="true" className="ml-auto w-[19rem] select-none">
      <p className="mb-3 text-label-sm font-semibold uppercase tracking-widest text-on-primary/55">
        The kind of thing you’ll find
      </p>
      <div className="flex flex-col gap-3">
        {EXAMPLES.map((c) => (
          <div
            key={c.title}
            className={`flex items-center gap-3 rounded-2xl bg-white p-2.5 pr-4 shadow-[0_18px_40px_-14px_rgba(0,10,30,0.55)] ${c.className}`}
          >
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-surface-container">
              <Image
                src={`${PHOTO_DIR}/${c.img}.webp`}
                alt=""
                fill
                sizes="64px"
                quality={70}
                className="object-cover"
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-label-lg font-semibold text-on-surface">{c.title}</p>
              <p className="truncate text-label-sm text-on-surface-variant">{c.meta}</p>
              <span
                className={`mt-1 inline-block rounded-full px-2 py-0.5 text-label-sm font-semibold ${c.pillClass}`}
              >
                {c.pill}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Small "made in Edinburgh" tag shown under the logo. */
export function SigninEdinburghTag() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-label-sm font-semibold text-on-primary/85 ring-1 ring-white/15 backdrop-blur-sm">
      <Icon name="castle" filled size={16} className="text-brand-orange" />
      Edinburgh
    </span>
  );
}
