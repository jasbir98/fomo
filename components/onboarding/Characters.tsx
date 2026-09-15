import type { ReactNode } from "react";

/**
 * Hand-drawn SVG cast for the welcome slides and sign-in: Fomo (the orange
 * logo dot, grown a face and limbs) plus the Edinburgh friends it keeps
 * running into — Nessie, a Highland coo, a ticket, a panicking alarm clock.
 *
 * Pure SVG + the `fomo-*` animation classes in app/globals.css, so there are
 * no image assets to fetch. Animated groups always sit *inside* a positioned
 * group (see `At`): a CSS transform on an SVG element replaces its
 * `transform` attribute, so position and animation can't share an element.
 * Colours are literal rather than theme tokens — this is illustration, and
 * ORANGE is the app icon's own dot (public/icons/icon.svg).
 */

const NAVY = "#1b365d";
const ORANGE = "#fc8a40";
const ORANGE_DEEP = "#e8702a";
const YELLOW = "#ffc93c";
const GOLD = "#e0a106";
const PURPLE = "#7c5cff";
const GREEN = "#3f9d6b";
const RED = "#ef5350";
const SKY = "#6aa9e9";
const TONGUE = "#ff7a8a";

type AtProps = { x: number; y: number; r?: number; s?: number; anim?: string; children: ReactNode };

/** Place + rotate + scale, with an optional animation class on an inner group. */
function At({ x, y, r = 0, s = 1, anim, children }: AtProps) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`}>
      {anim ? <g className={anim}>{children}</g> : children}
    </g>
  );
}

function Sparkle({ size = 8, color = YELLOW }: { size?: number; color?: string }) {
  const q = size * 0.18;
  return (
    <path
      d={`M0 ${-size}Q${q} ${-q} ${size} 0Q${q} ${q} 0 ${size}Q${-q} ${q} ${-size} 0Q${-q} ${-q} 0 ${-size}Z`}
      fill={color}
    />
  );
}

/** Firework: eight rays around a dot. Coordinates rounded so SSR and client agree. */
function Burst({ size = 20, color }: { size?: number; color: string }) {
  return (
    <g stroke={color} strokeWidth={3} strokeLinecap="round">
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        const cx = Math.round(Math.cos(a) * 100) / 100;
        const cy = Math.round(Math.sin(a) * 100) / 100;
        return (
          <line
            key={i}
            x1={Math.round(cx * size * 45) / 100}
            y1={Math.round(cy * size * 45) / 100}
            x2={Math.round(cx * size * 100) / 100}
            y2={Math.round(cy * size * 100) / 100}
          />
        );
      })}
      <circle r={2.5} fill={color} stroke="none" />
    </g>
  );
}

function Backdrop() {
  return (
    <path
      d="M180 30C262 26 328 80 324 164C320 246 256 294 176 290C96 286 36 238 38 158C40 78 98 34 180 30Z"
      fill="#ffffff"
      opacity={0.7}
    />
  );
}

// ---------------------------------------------------------------------------
// Fomo
// ---------------------------------------------------------------------------

export type FomoMood = "wow" | "grin" | "gasp" | "meh" | "hmm";
export type FomoPose = "cheer" | "hold" | "run" | "wave" | "shrug" | "none";

const ARMS: Record<FomoPose, string[]> = {
  cheer: ["M-40 -4Q-58 -18 -60 -40", "M40 -4Q58 -18 60 -40"],
  hold: ["M-42 8Q-58 18 -52 32", "M42 -6Q60 -24 62 -48"],
  run: ["M-40 4Q-58 14 -68 4", "M40 -8Q56 -32 50 -58"],
  wave: ["M-42 8Q-56 22 -50 36", "M42 -6Q62 -20 66 -42"],
  shrug: ["M-42 6Q-60 6 -64 -8", "M42 6Q60 6 64 -8"],
  none: [],
};

const HANDS: Record<FomoPose, [number, number][]> = {
  cheer: [[-60, -44], [60, -44]],
  hold: [[-52, 34], [62, -52]],
  run: [[-70, 2], [50, -62]],
  wave: [[-50, 38], [66, -46]],
  shrug: [[-66, -12], [66, -12]],
  none: [],
};

/** Where the pupils look, per mood: up for wow, down for meh, up-right for hmm. */
const LOOK: Record<FomoMood, [number, number]> = {
  wow: [0, -8],
  grin: [0, -3],
  gasp: [0, -3],
  meh: [0, 1],
  hmm: [4, -8],
};

/**
 * Fomo, centred on its body (radius ~48; feet reach y≈66, raised hands y≈-62).
 * wow/grin/gasp carry the onboarding scenes; meh is for "nothing here" states,
 * hmm for Ask Fomo thinking. Pose "none" drops the limbs (see FomoFace).
 */
export function FomoBuddy({ mood = "grin", pose = "wave" }: { mood?: FomoMood; pose?: FomoPose }) {
  const limb = { stroke: NAVY, strokeWidth: 5, strokeLinecap: "round" as const, fill: "none" };
  const pupil = mood === "gasp" ? 3.5 : 5.5;
  const [lookX, lookY] = LOOK[mood];

  return (
    <g>
      {pose === "none" ? null : pose === "run" ? (
        <>
          <path d="M-12 40Q-24 52 -38 50" {...limb} />
          <ellipse cx={-42} cy={49} rx={9} ry={5} fill={NAVY} transform="rotate(-20 -42 49)" />
          <path d="M12 40Q22 52 22 64" {...limb} />
          <ellipse cx={27} cy={66} rx={9} ry={5} fill={NAVY} />
        </>
      ) : (
        <>
          <path d="M-14 40L-16 58" {...limb} />
          <path d="M14 40L16 58" {...limb} />
          <ellipse cx={-20} cy={61} rx={9} ry={5} fill={NAVY} />
          <ellipse cx={20} cy={61} rx={9} ry={5} fill={NAVY} />
        </>
      )}
      {ARMS[pose].map((d) => (
        <path key={d} d={d} {...limb} />
      ))}
      {HANDS[pose].map(([hx, hy]) => (
        <circle key={`${hx},${hy}`} cx={hx} cy={hy} r={6} fill={NAVY} />
      ))}

      {/* Body, drawn after the limbs so shoulders and hips tuck behind it. */}
      <path d="M0 -48C29 -48 48 -27 48 0C48 29 27 46 0 46C-27 46 -48 29 -48 0C-48 -27 -29 -48 0 -48Z" fill={ORANGE} />
      <path d="M-42 16C-32 38 -8 45 10 42C-12 36 -32 28 -42 16Z" fill={ORANGE_DEEP} opacity={0.55} />
      <ellipse cx={-20} cy={-29} rx={12} ry={6} fill="#fff" opacity={0.4} transform="rotate(-35 -20 -29)" />

      {mood === "gasp" ? (
        <g stroke={NAVY} strokeWidth={3} strokeLinecap="round" fill="none">
          <path d="M-26 -26Q-16 -35 -6 -28" />
          <path d="M6 -28Q16 -35 26 -26" />
        </g>
      ) : mood === "hmm" ? (
        <path d="M6 -30Q16 -37 26 -31" stroke={NAVY} strokeWidth={3} strokeLinecap="round" fill="none" />
      ) : null}

      <g className="fomo-blink">
        <ellipse cx={-16} cy={-6} rx={11} ry={13} fill="#fff" />
        <ellipse cx={16} cy={-6} rx={11} ry={13} fill="#fff" />
        <circle cx={-14 + lookX} cy={lookY} r={pupil} fill={NAVY} />
        <circle cx={18 + lookX} cy={lookY} r={pupil} fill={NAVY} />
        <circle cx={-12 + lookX} cy={lookY - 2} r={1.8} fill="#fff" />
        <circle cx={20 + lookX} cy={lookY - 2} r={1.8} fill="#fff" />
        {mood === "meh" ? (
          // Heavy lids: body-coloured bars over the top of each eye.
          <>
            <rect x={-28} y={-20} width={24} height={11} fill={ORANGE} />
            <rect x={4} y={-20} width={24} height={11} fill={ORANGE} />
          </>
        ) : null}
      </g>

      <ellipse cx={-33} cy={12} rx={7} ry={4} fill="#ff5a5a" opacity={0.3} />
      <ellipse cx={33} cy={12} rx={7} ry={4} fill="#ff5a5a" opacity={0.3} />

      {mood === "grin" ? (
        <>
          <path d="M-13 13Q0 32 13 13Z" fill={NAVY} />
          <path d="M-6 19Q0 14 6 19Q0 24 -6 19Z" fill={TONGUE} />
        </>
      ) : mood === "wow" ? (
        <>
          <ellipse cx={0} cy={20} rx={7} ry={9} fill={NAVY} />
          <ellipse cx={0} cy={25} rx={4} ry={2.5} fill={TONGUE} />
        </>
      ) : mood === "meh" ? (
        <path d="M-9 21Q-4.5 17 0 21T9 21" stroke={NAVY} strokeWidth={3} strokeLinecap="round" fill="none" />
      ) : mood === "hmm" ? (
        <ellipse cx={7} cy={21} rx={4} ry={3.5} fill={NAVY} />
      ) : (
        <>
          <ellipse cx={0} cy={21} rx={9} ry={10} fill={NAVY} />
          <ellipse cx={0} cy={26} rx={5} ry={3} fill={TONGUE} />
        </>
      )}
    </g>
  );
}

/** Fomo's face alone (no limbs), sized by className — chat avatars and the nav button. */
export function FomoFace({ mood = "grin", className = "" }: { mood?: FomoMood; className?: string }) {
  return (
    <svg viewBox="-50 -50 100 100" className={className} aria-hidden="true">
      <FomoBuddy mood={mood} pose="none" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Supporting cast
// ---------------------------------------------------------------------------

function TicketPal() {
  return (
    <g>
      <path d="M-34 2Q-46 -4 -48 -16" stroke={NAVY} strokeWidth={2.5} strokeLinecap="round" fill="none" />
      <circle cx={-48} cy={-18} r={3.2} fill={NAVY} />
      <path
        d="M-34 -20H34V-7A7 7 0 0 0 34 7V20H-34V7A7 7 0 0 0 -34 -7Z"
        fill={YELLOW}
        stroke={NAVY}
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <line x1={14} y1={-16} x2={14} y2={16} stroke={NAVY} strokeWidth={2} strokeDasharray="3 3" />
      <At x={24} y={0}>
        <Sparkle size={6} color={ORANGE} />
      </At>
      <circle cx={-12} cy={-4} r={3} fill={NAVY} />
      <circle cx={2} cy={-4} r={3} fill={NAVY} />
      <path d="M-10 5Q-5 11 0 5" stroke={NAVY} strokeWidth={2.2} fill="none" strokeLinecap="round" />
    </g>
  );
}

function NotePal() {
  return (
    <g>
      <path d="M8 -30V14" stroke={NAVY} strokeWidth={4} strokeLinecap="round" />
      <path d="M8 -30Q22 -26 26 -12" stroke={NAVY} strokeWidth={4} fill="none" strokeLinecap="round" />
      <ellipse cx={-2} cy={16} rx={13} ry={10} fill={PURPLE} transform="rotate(-20 -2 16)" />
      <circle cx={-7} cy={14} r={2.2} fill="#fff" />
      <circle cx={1} cy={11} r={2.2} fill="#fff" />
      <path d="M-7 19Q-2 23 2 17" stroke="#fff" strokeWidth={1.8} fill="none" strokeLinecap="round" />
    </g>
  );
}

function Nessie() {
  return (
    <g>
      <path d="M52 22Q66 -6 80 22Z" fill={GREEN} />
      <path d="M86 22Q97 4 108 22Z" fill={GREEN} />
      <path d="M12 22C10 2 14 -18 24 -26C34 -34 50 -30 50 -18C50 -8 40 -8 34 -4C28 0 28 12 30 22Z" fill={GREEN} />
      <circle cx={20} cy={4} r={3} fill="#6cc393" />
      <circle cx={24} cy={14} r={2.2} fill="#6cc393" />
      <circle cx={66} cy={12} r={2.5} fill="#6cc393" />
      <circle cx={40} cy={-19} r={4} fill="#fff" />
      <circle cx={41} cy={-19} r={2.2} fill={NAVY} />
      <path d="M43 -11Q47 -9 50 -12" stroke={NAVY} strokeWidth={1.8} fill="none" strokeLinecap="round" />
      <path
        d="M-4 24Q9 16 22 24T48 24T74 24T100 24T126 24"
        stroke={SKY}
        strokeWidth={3.5}
        fill="none"
        strokeLinecap="round"
      />
    </g>
  );
}

function HighlandCoo() {
  return (
    <g>
      {/* horns */}
      <path d="M-30 -26C-52 -30 -62 -48 -54 -64C-50 -50 -40 -42 -24 -40Z" fill="#f5e6c8" stroke={NAVY} strokeWidth={2} strokeLinejoin="round" />
      <path d="M30 -26C52 -30 62 -48 54 -64C50 -50 40 -42 24 -40Z" fill="#f5e6c8" stroke={NAVY} strokeWidth={2} strokeLinejoin="round" />
      {/* ears */}
      <ellipse cx={-44} cy={-12} rx={14} ry={7} fill="#b85f2a" transform="rotate(-20 -44 -12)" />
      <ellipse cx={44} cy={-12} rx={14} ry={7} fill="#b85f2a" transform="rotate(20 44 -12)" />
      {/* head + shaggy fringe, one eye peeking through */}
      <path d="M-34 -36C-34 -52 34 -52 34 -36L38 20C38 44 -38 44 -38 20Z" fill="#d9803f" />
      <circle cx={15} cy={-1} r={3.4} fill={NAVY} />
      <circle cx={16} cy={-2} r={1.1} fill="#fff" />
      <path
        d="M-38 -34C-30 -56 30 -56 38 -34L34 -10L26 -20L19 -6L8 -18L0 -4L-8 -18L-18 -6L-26 -20L-34 -10Z"
        fill="#b85f2a"
      />
      {/* snout */}
      <ellipse cx={0} cy={22} rx={28} ry={18} fill="#f4b3a0" />
      <ellipse cx={-9} cy={21} rx={3.5} ry={4.5} fill="#8a4b3a" />
      <ellipse cx={9} cy={21} rx={3.5} ry={4.5} fill="#8a4b3a" />
      <path d="M-10 32Q0 38 10 32" stroke="#8a4b3a" strokeWidth={2.2} fill="none" strokeLinecap="round" />
      {/* tartan scarf */}
      <path d="M-32 38Q0 52 32 38L30 50Q0 64 -30 50Z" fill={RED} />
      <g stroke={NAVY} strokeWidth={2} opacity={0.45}>
        <path d="M-18 44L-18 56" />
        <path d="M0 47L0 59" />
        <path d="M18 44L18 56" />
      </g>
      <path d="M-31 45Q0 58 31 45" stroke={YELLOW} strokeWidth={1.5} fill="none" opacity={0.8} />
    </g>
  );
}

function Bubble({ text }: { text: string }) {
  return (
    <g>
      <path
        d="M-40 -18H40Q48 -18 48 -10V10Q48 18 40 18H14L4 32L2 18H-40Q-48 18 -48 10V-10Q-48 -18 -40 -18Z"
        fill="#fff"
        stroke={NAVY}
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <text y={6} textAnchor="middle" fontSize={16} fontWeight={800} fill={NAVY}>
        {text}
      </text>
    </g>
  );
}

function PriceTag() {
  return (
    <g>
      <path
        d="M-30 -20H16L36 0L16 20H-30Q-36 20 -36 14V-14Q-36 -20 -30 -20Z"
        fill={YELLOW}
        stroke={NAVY}
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <circle cx={18} cy={0} r={4} fill="#fff" stroke={NAVY} strokeWidth={2} />
      <text x={-9} y={8} textAnchor="middle" fontSize={22} fontWeight={800} fill={NAVY}>
        £4
      </text>
    </g>
  );
}

function CoffeePal() {
  return (
    <g>
      <g className="fomo-steam" stroke={NAVY} strokeWidth={2.5} strokeLinecap="round" fill="none">
        <path d="M-6 -34Q-10 -42 -6 -50" />
        <path d="M6 -34Q10 -42 6 -50" />
      </g>
      <path d="M-19 -18H19L15 22Q14 27 9 27H-9Q-14 27 -15 22Z" fill="#fff" stroke={NAVY} strokeWidth={2.5} strokeLinejoin="round" />
      <rect x={-23} y={-26} width={46} height={9} rx={4} fill={NAVY} />
      <path d="M-17.4 -2H17.4L16 12H-16Z" fill={ORANGE} />
      <circle cx={-7} cy={-9} r={2.6} fill={NAVY} />
      <path d="M4 -9Q7 -12 10 -9" stroke={NAVY} strokeWidth={2.2} fill="none" strokeLinecap="round" />
      <path d="M-5 3Q0 8 5 3" stroke="#fff" strokeWidth={2.2} fill="none" strokeLinecap="round" />
    </g>
  );
}

function GradCap() {
  return (
    <g>
      <path d="M-14 2V12Q0 20 14 12V2" fill={NAVY} />
      <path d="M0 -12L28 0L0 12L-28 0Z" fill="#2c5282" />
      <path d="M0 0L20 4V18" stroke={YELLOW} strokeWidth={2.5} fill="none" strokeLinecap="round" />
      <circle cx={20} cy={20} r={3.5} fill={YELLOW} />
    </g>
  );
}

function CoinPal({ r = 16 }: { r?: number }) {
  const k = r / 16;
  return (
    <g>
      <circle r={r} fill={YELLOW} stroke={GOLD} strokeWidth={3} />
      <circle r={r - 5} fill="none" stroke={GOLD} strokeWidth={1.5} opacity={0.6} />
      <circle cx={-5 * k} cy={-3 * k} r={2.2 * k} fill={NAVY} />
      <circle cx={5 * k} cy={-3 * k} r={2.2 * k} fill={NAVY} />
      <path d={`M${-5 * k} ${4 * k}Q0 ${9 * k} ${5 * k} ${4 * k}`} stroke={NAVY} strokeWidth={2} fill="none" strokeLinecap="round" />
    </g>
  );
}

function AlarmPal() {
  return (
    <g>
      <g stroke={NAVY} strokeWidth={4} strokeLinecap="round">
        <path d="M-18 28L-24 40" />
        <path d="M18 28L24 40" />
      </g>
      <circle cx={-20} cy={-26} r={10} fill={RED} stroke={NAVY} strokeWidth={2.5} />
      <circle cx={20} cy={-26} r={10} fill={RED} stroke={NAVY} strokeWidth={2.5} />
      <circle r={30} fill="#fff" stroke={NAVY} strokeWidth={3.5} />
      <g stroke={NAVY} strokeWidth={2.5} strokeLinecap="round" opacity={0.5}>
        <path d="M0 -25V-21" />
        <path d="M25 0H21" />
        <path d="M-25 0H-21" />
      </g>
      <circle cx={-10} cy={-6} r={4.5} fill={NAVY} />
      <circle cx={10} cy={-6} r={4.5} fill={NAVY} />
      <circle cx={-9} cy={-7.5} r={1.4} fill="#fff" />
      <circle cx={11} cy={-7.5} r={1.4} fill="#fff" />
      <ellipse cx={0} cy={13} rx={5} ry={6} fill={NAVY} />
      <path d="M31 -20Q35 -12 31 -8Q27 -12 31 -20Z" fill={SKY} />
      <g stroke={NAVY} strokeWidth={3} strokeLinecap="round" fill="none">
        <path d="M-40 -22Q-46 -12 -42 0" />
        <path d="M40 -26Q46 -16 44 -4" />
      </g>
    </g>
  );
}

function PhonePal() {
  return (
    <g>
      <g stroke={NAVY} strokeWidth={2.5} strokeLinecap="round" opacity={0.4}>
        <path d="M-34 -24L-38 -14" />
        <path d="M-36 -2L-40 8" />
        <path d="M34 -24L38 -14" />
        <path d="M36 -2L40 8" />
      </g>
      <rect x={-26} y={-46} width={52} height={92} rx={10} fill={NAVY} />
      <rect x={-21} y={-38} width={42} height={74} rx={6} fill="#eaf1ff" />
      <rect x={-17} y={-33} width={34} height={17} rx={5} fill={ORANGE} />
      <path d="M-12 -20Q-12 -29 -7 -29Q-2 -29 -2 -20Z" fill="#fff" />
      <circle cx={-7} cy={-18.5} r={1.5} fill="#fff" />
      <rect x={2} y={-28} width={11} height={2.5} rx={1.2} fill="#fff" />
      <rect x={2} y={-22.5} width={7} height={2.5} rx={1.2} fill="#fff" />
      <circle cx={-8} cy={4} r={3} fill={NAVY} />
      <circle cx={8} cy={4} r={3} fill={NAVY} />
      <path d="M-8 14Q0 21 8 14" stroke={NAVY} strokeWidth={2.2} fill="none" strokeLinecap="round" />
    </g>
  );
}

function SoldOutStamp() {
  return (
    <g>
      <rect x={-50} y={-16} width={100} height={32} rx={6} fill="#fff" fillOpacity={0.7} stroke={RED} strokeWidth={3} />
      <rect x={-45} y={-11} width={90} height={22} rx={3} fill="none" stroke={RED} strokeWidth={1.2} />
      <text y={5} textAnchor="middle" fontSize={13} fontWeight={800} letterSpacing={1} fill={RED}>
        SOLD OUT
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Scenes (viewBox 360×320)
// ---------------------------------------------------------------------------

const CASTLE =
  "M170 262C196 240 214 232 232 228L232 206L240 206L240 199L247 199L247 206L255 206L255 188L260 179L265 188L265 206L281 206L281 196L288 196L288 201L295 201L295 196L302 196L302 206L312 206L312 198L320 198L320 206L326 206L326 232C334 240 340 250 340 262Z";

function Scene({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 360 320" className="h-full w-full" aria-hidden="true">
      <Backdrop />
      {children}
    </svg>
  );
}

/** Slide 1 — Fomo cheering at the castle fireworks, with Nessie and friends. */
export function WhatsOnScene() {
  return (
    <Scene>
      <path d={CASTLE} fill={NAVY} opacity={0.14} />
      <path d="M260 179V164" stroke={NAVY} strokeWidth={2} opacity={0.3} />
      <path d="M260 164L272 168L260 172Z" fill={ORANGE} />

      <At x={250} y={82} anim="fomo-twinkle">
        <Burst size={24} color={PURPLE} />
      </At>
      <At x={318} y={118} anim="fomo-twinkle fomo-delay-1">
        <Burst size={14} color={ORANGE} />
      </At>
      <At x={196} y={52} anim="fomo-twinkle fomo-delay-2">
        <Burst size={12} color={YELLOW} />
      </At>

      <At x={40} y={64} anim="fomo-twinkle fomo-delay-1">
        <Sparkle size={7} />
      </At>
      <At x={130} y={46} anim="fomo-twinkle">
        <Sparkle size={5} color={ORANGE} />
      </At>
      <At x={300} y={50} anim="fomo-twinkle fomo-delay-2">
        <Sparkle size={6} color={PURPLE} />
      </At>
      <rect x={112} y={140} width={8} height={4} rx={1} fill={PURPLE} transform="rotate(30 116 142)" />
      <rect x={214} y={138} width={8} height={4} rx={1} fill={YELLOW} transform="rotate(-25 218 140)" />
      <rect x={92} y={186} width={7} height={4} rx={1} fill={ORANGE} transform="rotate(60 95 188)" />

      <At x={78} y={106} r={-14} anim="fomo-float">
        <TicketPal />
      </At>
      <At x={46} y={188} r={10} anim="fomo-bob fomo-delay-1">
        <NotePal />
      </At>
      <At x={6} y={264} s={0.8} anim="fomo-bob">
        <Nessie />
      </At>

      <ellipse cx={152} cy={284} rx={44} ry={7} fill={NAVY} opacity={0.12} />
      <At x={152} y={214} anim="fomo-hop">
        <FomoBuddy mood="wow" pose="cheer" />
      </At>
    </Scene>
  );
}

/** Slide 2 — Fomo shows off a £4 deal while a Highland coo shouts 2-for-1. */
export function DealsScene() {
  return (
    <Scene>
      <At x={40} y={170} anim="fomo-twinkle">
        <Sparkle size={6} color={ORANGE} />
      </At>
      <At x={236} y={52} anim="fomo-twinkle fomo-delay-2">
        <Sparkle size={7} />
      </At>
      <At x={180} y={170} anim="fomo-twinkle fomo-delay-1">
        <Sparkle size={5} color={PURPLE} />
      </At>

      <At x={84} y={96} r={-6} anim="fomo-float fomo-delay-1">
        <Bubble text="2 for 1!" />
      </At>
      <At x={178} y={94} r={6} anim="fomo-float">
        <CoffeePal />
      </At>
      <At x={296} y={58} r={12} anim="fomo-bob fomo-delay-2">
        <GradCap />
      </At>

      <ellipse cx={100} cy={292} rx={40} ry={6} fill={NAVY} opacity={0.1} />
      <At x={100} y={232} anim="fomo-bob">
        <HighlandCoo />
      </At>

      <At x={180} y={276} anim="fomo-hop fomo-delay-1">
        <CoinPal />
      </At>
      <At x={208} y={292} anim="fomo-hop fomo-delay-2">
        <CoinPal r={10} />
      </At>

      <ellipse cx={252} cy={282} rx={42} ry={7} fill={NAVY} opacity={0.12} />
      <g className="fomo-float">
        <At x={252} y={212}>
          <FomoBuddy mood="grin" pose="hold" />
        </At>
        <At x={320} y={130} r={-14}>
          <PriceTag />
        </At>
      </g>
    </Scene>
  );
}

/** Slide 3 — Fomo sprints a ticket past the alarm clock, just ahead of SOLD OUT. */
export function BookEarlyScene() {
  return (
    <Scene>
      <At x={290} y={66} r={12} anim="fomo-float fomo-delay-1">
        <SoldOutStamp />
      </At>
      <At x={74} y={98} anim="fomo-shake">
        <AlarmPal />
      </At>
      <At x={300} y={212} r={8} anim="fomo-buzz">
        <PhonePal />
      </At>

      <g className="fomo-dash" stroke={NAVY} strokeWidth={4} strokeLinecap="round" opacity={0.22} strokeDasharray="26 14">
        <path d="M44 184H104" />
        <path d="M30 208H100" />
        <path d="M52 232H108" />
      </g>

      <At x={266} y={110} anim="fomo-twinkle">
        <Sparkle size={7} />
      </At>
      <At x={196} y={104} anim="fomo-twinkle fomo-delay-2">
        <Sparkle size={5} color={ORANGE} />
      </At>

      <ellipse cx={172} cy={284} rx={46} ry={7} fill={NAVY} opacity={0.12} />
      <g className="fomo-hop">
        <At x={170} y={206} r={8}>
          <FomoBuddy mood="grin" pose="run" />
        </At>
        <At x={236} y={134} r={18} s={0.85}>
          <TicketPal />
        </At>
      </g>
    </Scene>
  );
}
