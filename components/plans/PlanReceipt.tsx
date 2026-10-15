import Link from "next/link";
import { SmartImage } from "@/components/ui";
import { dayCode, type PlanSummary } from "@/lib/plans/format";
import { receiptMoney } from "@/lib/plans/price";
import { planItemHref, type PlanItem } from "@/lib/plans/types";

/** A line's price in till-roll form: "£0.00", "£12.00+" for a floor, or the pill text ("20% off") when there's no number. */
function linePrice(item: PlanItem): string {
  if (item.price.amount == null) return item.price.label ?? "TBC";
  return `${receiptMoney(item.price.amount)}${item.price.from ? "+" : ""}`;
}

/**
 * The plan as a paper receipt, the same look as the Instagram "£0 weekend"
 * post and the link's OG image (lib/og/receipt-image.tsx). Every line links
 * to its detail page. Server component.
 */
export function PlanReceipt({ items, summary }: { items: PlanItem[]; summary: PlanSummary }) {
  const { total } = summary;
  const free = total.amount === 0 && total.unknown === 0;
  return (
    <div className="relative mx-auto w-full max-w-[440px] rounded-t-xl bg-[#fbfaf6] px-4 pb-8 pt-6 font-mono text-[#0f1d33] shadow-level-2 [mask-image:radial-gradient(circle_at_8px_100%,transparent_7px,#000_7.5px)] [mask-position:0_100%] [mask-repeat:repeat-x] [mask-size:16px_100%]">
      <div className="text-center">
        <p className="text-[22px] font-bold tracking-[0.3em]">ASKFOMO</p>
        <p className="mt-1 text-label-sm uppercase tracking-[0.12em] text-[#51607a]">Edinburgh · {summary.range}</p>
      </div>
      <hr className="my-4 border-0 border-t-2 border-dashed border-[#c9ccd3]" />
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`}>
            <Link
              href={planItemHref(item)}
              className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-black/[0.04]"
            >
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-[#e9e6dc]">
                <SmartImage src={item.image} alt="" width={48} height={48} className="h-full w-full object-cover" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-label-sm font-bold uppercase tracking-wider text-[#51607a]">
                  {dayCode(item.day)}
                  {item.time ? ` ${item.time}` : ""}
                </span>
                <span className="line-clamp-2 font-sans text-body-md font-bold leading-snug">{item.title}</span>
                {item.venue ? <span className="truncate font-sans text-label-sm text-[#51607a]">{item.venue}</span> : null}
              </div>
              <span className="shrink-0 self-start pt-4 text-label-lg font-bold">{linePrice(item)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <hr className="my-4 border-0 border-t-2 border-dashed border-[#c9ccd3]" />
      <div className="flex items-baseline justify-between">
        <span className="text-[24px] font-bold tracking-wider">TOTAL</span>
        <span className="text-[28px] font-bold">
          {total.from ? "from " : ""}
          {receiptMoney(total.amount)}
        </span>
      </div>
      {total.unknown > 0 ? (
        <p className="mt-1 text-right text-label-sm text-[#51607a]">
          + {total.unknown} price{total.unknown === 1 ? "" : "s"} to check
        </p>
      ) : null}
      <hr className="my-4 border-0 border-t-2 border-dashed border-[#c9ccd3]" />
      <p className="text-center text-label-md font-bold tracking-[0.2em]">{free ? "THANK YOU FOR NOT SPENDING" : "CHEAP. CHEERFUL. SORTED."}</p>
      <div
        aria-hidden="true"
        className="mx-auto mt-3 h-10 w-48 bg-[repeating-linear-gradient(90deg,#0f1d33_0_2px,transparent_2px_4px,#0f1d33_4px_5px,transparent_5px_8px,#0f1d33_8px_11px,transparent_11px_13px)]"
      />
    </div>
  );
}

export default PlanReceipt;
