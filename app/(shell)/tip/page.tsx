"use client";

import { useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Icon, PageHeader } from "@/components/ui";
import { track } from "@/lib/analytics/track";
import { PlaceField } from "@/components/tip/PlaceField";

type FormStatus = "idle" | "sending" | "done" | "error";

type TipFormData = {
  title: string;
  location_text: string;
  /** Google place id when "Where?" came from a suggestion; empty for free text. */
  location_place_id: string;
  url: string;
  when_text: string;
  price_text: string;
  details: string;
  submitter_kind: string;
  contact_email: string;
  website: string; // honeypot
};

export default function TipPage() {
  const searchParams = useSearchParams();
  const isFeedback = searchParams.get("type") === "feedback";
  
  const pageTitle = isFeedback ? "Send feedback" : "Tip us off";
  const introText = isFeedback
    ? "Help us improve Fomo. Tell us what you think, what's missing, or what could be better."
    : "Know a free event or a deal in Edinburgh we're missing? Tell us and we'll check it out.";

  const [formData, setFormData] = useState<TipFormData>({
    title: "",
    location_text: "",
    location_place_id: "",
    url: "",
    when_text: "",
    price_text: "",
    details: "",
    submitter_kind: "",
    contact_email: "",
    website: "",
  });
  const [status, setStatus] = useState<FormStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (status === "sending" || status === "done") return;

    setStatus("sending");
    setErrorMessage(null);

    try {
      const res = await fetch("/api/tips", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Feedback shares the tips inbox; the prefix keeps it sortable from real tips in review.
        body: JSON.stringify(isFeedback ? { ...formData, title: `[Feedback] ${formData.title}`.slice(0, 200) } : formData),
      });

      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;

      if (!res.ok || !body?.ok) {
        setStatus("error");
        setErrorMessage(body?.error ?? "Couldn't save that. Try again.");
        return;
      }

      track("tip_submitted", { type: isFeedback ? "feedback" : "tip" });
      setStatus("done");
      setFormData({
        title: "",
        location_text: "",
    location_place_id: "",
        url: "",
        when_text: "",
        price_text: "",
        details: "",
        submitter_kind: "",
        contact_email: "",
        website: "",
      });
    } catch {
      setStatus("error");
      setErrorMessage("Couldn't save that. Check your connection and try again.");
    }
  }

  if (status === "done") {
    return (
      <main className="mx-auto flex max-w-[480px] flex-col gap-4 pb-6 lg:max-w-2xl lg:px-8">
        <PageHeader title={pageTitle} showBack />
        <div className="flex flex-col items-center gap-4 px-4 py-8">
          <Icon name="check_circle" size={48} className="text-primary" filled />
          <div className="flex flex-col gap-2 text-center">
            <h2 className="text-headline-md font-bold text-on-surface">
              {isFeedback ? "Thanks for your feedback" : "Thanks for the tip"}
            </h2>
            <p className="text-body-md text-on-surface-variant">
              {isFeedback
                ? "We read every message. Thanks for helping make Fomo better."
                : "We check every tip before it goes live. If it's a cracker, you'll see it on Fomo soon."}
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-[480px] flex-col gap-4 pb-6 lg:max-w-2xl lg:px-8">
      <PageHeader title={pageTitle} showBack />

      <div className="flex flex-col gap-4 px-4">
        {/* Intro */}
        <div className="flex flex-col gap-2">
          <p className="text-body-md text-on-surface-variant">
            {introText}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* What is it? / Subject (for feedback) */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="title" className="text-label-md font-medium text-on-surface">
              {isFeedback ? "What's on your mind?" : "What is it?"} <span className="text-error">*</span>
            </label>
            <input
              id="title"
              type="text"
              name="title"
              required
              maxLength={200}
              placeholder={isFeedback ? "e.g. Add a wishlist feature" : "e.g. Free brunch at The Meadows"}
              value={formData.title}
              onChange={handleInputChange}
              disabled={status === "sending"}
              className="min-h-11 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-70"
            />
          </div>

          {/* Where? — only shown if not feedback */}
          {!isFeedback ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="location_text" className="text-label-md font-medium text-on-surface">
                Where?
              </label>
              <PlaceField
                id="location_text"
                placeholder="e.g. The Stand, York Place or Leith"
                value={formData.location_text}
                onChange={(text) => setFormData((prev) => ({ ...prev, location_text: text, location_place_id: "" }))}
                onPick={(text, placeId) => setFormData((prev) => ({ ...prev, location_text: text, location_place_id: placeId }))}
                disabled={status === "sending"}
                className="min-h-11 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-70"
              />
            </div>
          ) : null}

          {/* Link — only shown if not feedback. Free text on purpose (not type="url"):
              the server normalises it and never rejects a tip over it. */}
          {!isFeedback ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="url" className="text-label-md font-medium text-on-surface">
                Link <span className="text-on-surface-variant font-normal">(optional)</span>
              </label>
              <input
                id="url"
                type="text"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                name="url"
                maxLength={1000}
                placeholder="Website, Instagram or ticket link"
                value={formData.url}
                onChange={handleInputChange}
                disabled={status === "sending"}
                className="min-h-11 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-70"
              />
            </div>
          ) : null}

          {/* When? — only shown if not feedback */}
          {!isFeedback ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="when_text" className="text-label-md font-medium text-on-surface">
                When?
              </label>
              <input
                id="when_text"
                type="text"
                name="when_text"
                maxLength={200}
                placeholder="e.g. Every Saturday, 10am–12pm"
                value={formData.when_text}
                onChange={handleInputChange}
                disabled={status === "sending"}
                className="min-h-11 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-70"
              />
            </div>
          ) : null}

          {/* Price/deal — only shown if not feedback */}
          {!isFeedback ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="price_text" className="text-label-md font-medium text-on-surface">
                Price/deal
              </label>
              <input
                id="price_text"
                type="text"
                name="price_text"
                maxLength={100}
                placeholder="e.g. £5 entry, students free"
                value={formData.price_text}
                onChange={handleInputChange}
                disabled={status === "sending"}
                className="min-h-11 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-70"
              />
            </div>
          ) : null}

          {/* Details */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="details" className="text-label-md font-medium text-on-surface">
              {isFeedback ? "Tell us more" : "Details"}
            </label>
            <textarea
              id="details"
              name="details"
              maxLength={2000}
              placeholder={isFeedback ? "Any additional context or ideas…" : "Add anything else we should know…"}
              value={formData.details}
              onChange={handleInputChange}
              disabled={status === "sending"}
              rows={4}
              className="min-h-24 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-body-md text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-70 resize-none"
            />
          </div>

          {/* I'm a… — only shown if not feedback */}
          {!isFeedback ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="submitter_kind" className="text-label-md font-medium text-on-surface">
                I&rsquo;m a…
              </label>
              <select
                id="submitter_kind"
                name="submitter_kind"
                value={formData.submitter_kind}
                onChange={handleInputChange}
                disabled={status === "sending"}
                className="min-h-11 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-70"
              >
                <option value="">Pick one (optional)</option>
                <option value="student">Student</option>
                <option value="local">Local</option>
                <option value="venue">Venue owner/staff</option>
                <option value="other">Other</option>
              </select>
            </div>
          ) : null}

          {/* Email */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="contact_email" className="text-label-md font-medium text-on-surface">
              Your email
            </label>
            <input
              id="contact_email"
              type="email"
              name="contact_email"
              inputMode="email"
              autoComplete="email"
              maxLength={254}
              placeholder="optional, only if you want a reply"
              value={formData.contact_email}
              onChange={handleInputChange}
              disabled={status === "sending"}
              className="min-h-11 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-70"
            />
          </div>

          {/* Honeypot */}
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={formData.website}
            onChange={handleInputChange}
            className="absolute h-0 w-0 opacity-0"
            style={{ left: "-9999px" }}
          />

          {/* Error message */}
          {status === "error" && errorMessage ? (
            <p className="text-label-sm font-medium text-error" role="alert">
              {errorMessage}
            </p>
          ) : null}

          {/* Submit button */}
          <button
            type="submit"
            disabled={status === "sending" || !formData.title.trim()}
            className="flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 text-label-md font-bold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {status === "sending" ? (
              <>
                <Icon name="progress_activity" size={18} className="animate-spin mr-2" />
                Sending…
              </>
            ) : (
              isFeedback ? "Send feedback" : "Send tip"
            )}
          </button>
        </form>
      </div>
    </main>
  );
}
