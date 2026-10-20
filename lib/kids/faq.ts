/**
 * Copy for the /kids landing page: the FAQ (shown on the page and sent as
 * FAQPage structured data) and the school-holiday dates it quotes.
 *
 * Facts only — no prices beyond what's stated here. Update SCHOOL_HOLIDAYS
 * when the council publishes the next term dates.
 */
import { absoluteUrl } from "@/lib/seo/site";

/** City of Edinburgh school holidays, soonest first. The one place these dates live. */
export const SCHOOL_HOLIDAYS: { name: string; from: string; to: string; label: string }[] = [
  { name: "Christmas holidays", from: "2026-12-21", to: "2027-01-05", label: "21 December 2026 to 5 January 2027" },
  { name: "February mid-term break", from: "2027-02-15", to: "2027-02-19", label: "15 to 19 February 2027" },
];

/** The holidays that haven't finished by `today` ("YYYY-MM-DD"), for the FAQ answer. */
export function upcomingSchoolHolidays(today: string) {
  return SCHOOL_HOLIDAYS.filter((h) => h.to >= today);
}

function holidaysSentence(today: string): string {
  const next = upcomingSchoolHolidays(today);
  if (next.length === 0) return "Check the City of Edinburgh Council website for the next school holiday dates.";
  return `The next Edinburgh school holidays are: ${next.map((h) => `${h.name}, ${h.label}`).join("; ")}.`;
}

export interface FaqItem {
  question: string;
  answer: string;
}

/** `today` keeps a finished holiday out of the answer; pass the page's current day. */
export function kidsFaq(today: string): FaqItem[] {
  return [
    {
      question: "What's free to do with kids in Edinburgh?",
      answer:
        "The National Museum of Scotland, the National Galleries of Scotland and the Museum of Childhood are all free to enter. The grounds of the Royal Botanic Garden are free, and there are free playparks at Inverleith Park and West Princes Street Gardens.",
    },
    {
      question: "Where do kids eat free in Edinburgh?",
      answer:
        "Some Edinburgh restaurants and cafes run kids-eat-free and kids-go-free offers. Any we have found are listed in the Kids go free and kids eat free section on this page, each with its own dates and conditions. Offers change, so check the dates before you go.",
    },
    {
      question: "Do under-5s travel free on trains?",
      answer:
        "Yes. On ScotRail, children under 5 travel free. Kids for a Quid lets up to four children aged 5 to 15 travel for £1 return each with a paying adult.",
    },
    {
      question: "What's on in the school holidays?",
      answer: `${holidaysSentence(today)} Events and activities for those weeks appear in the Coming up section on this page as they are added.`,
    },
    {
      question: "Is Bookbug free?",
      answer:
        "Yes. Bookbug is a free programme of rhyme and story sessions for children aged 0 to 4 at Edinburgh libraries. Times differ by branch, so check your local library.",
    },
  ];
}

/** schema.org FAQPage for the same items the page shows. */
export function faqJsonLd(items: FaqItem[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    url: absoluteUrl("/kids"),
    mainEntity: items.map((i) => ({
      "@type": "Question",
      name: i.question,
      acceptedAnswer: { "@type": "Answer", text: i.answer },
    })),
  };
}
