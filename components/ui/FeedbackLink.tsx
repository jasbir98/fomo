"use client";

import { useRouter } from "next/navigation";
import { Icon } from "./Icon";

export type FeedbackLinkProps = {
  className?: string;
};

/**
 * Feedback entry point — a tonal chip/button that either displays a PostHog survey
 * (if NEXT_PUBLIC_POSTHOG_FEEDBACK_SURVEY_ID and posthog exist) or navigates to /tip?type=feedback.
 */
export function FeedbackLink({ className = "" }: FeedbackLinkProps) {
  const router = useRouter();

  function handleClick() {
    const surveyId = process.env.NEXT_PUBLIC_POSTHOG_FEEDBACK_SURVEY_ID;
    if (surveyId && typeof window !== "undefined" && window.posthog?.displaySurvey) {
      window.posthog.displaySurvey(surveyId);
    } else {
      router.push("/tip?type=feedback");
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-4 min-h-[36px] text-label-md font-medium whitespace-nowrap transition-colors bg-surface-container text-on-surface-variant border border-transparent hover:bg-surface-container-high ${className}`}
    >
      <Icon name="chat" size={18} />
      Feedback
    </button>
  );
}

export default FeedbackLink;
