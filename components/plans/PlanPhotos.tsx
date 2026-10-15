import Link from "next/link";
import { SmartImage } from "@/components/ui";
import { dayCode } from "@/lib/plans/format";
import { planItemHref, type PlanItem } from "@/lib/plans/types";

/**
 * The plan's photos as a collage, each linking to its detail page, with a
 * day chip like the share image (lib/og/receipt-image.tsx). Desktop only on
 * the plan page, where the receipt leaves a whole column free. Two columns;
 * an odd last photo spans both.
 */
export function PlanPhotos({ items, className = "" }: { items: PlanItem[]; className?: string }) {
  return (
    <div className={`grid-cols-2 gap-3 ${className}`}>
      {items.map((item, i) => (
        <Link
          key={`${item.kind}-${item.id}`}
          href={planItemHref(item)}
          className={`group relative block overflow-hidden rounded-2xl bg-surface-container ${
            items.length % 2 === 1 && i === items.length - 1 ? "col-span-2 aspect-[2.2/1]" : "aspect-[4/3]"
          }`}
        >
          <SmartImage
            src={item.image}
            alt={item.title}
            width={520}
            height={390}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/70 to-transparent" />
          <div className="absolute inset-x-3 bottom-3 flex flex-col items-start gap-1.5">
            <span className="rounded-full bg-[#fc8a40] px-2.5 py-0.5 font-mono text-label-sm font-bold text-[#0f1d33]">
              {dayCode(item.day)}
              {item.time ? ` ${item.time}` : ""}
            </span>
            <span className="line-clamp-2 text-label-lg font-bold leading-snug text-white">{item.title}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

export default PlanPhotos;
