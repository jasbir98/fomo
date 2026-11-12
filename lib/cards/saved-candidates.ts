import "server-only";
import { loadSubjects, type SubjectRef } from "@/lib/cards/resolve";
import { CITY } from "@/lib/city";
import { eventHasEnded } from "@/lib/events/format";
import { happeningHasEnded } from "@/lib/happenings/occurrence";
import { placeImage, placeCoords, eventHeadline, venueLabel } from "@/lib/cards/place";
import type { Candidate } from "@/lib/cards/types";
import type { Db } from "@/lib/supabase/types";

/** Resolves one page of saved_items rows into Candidate objects, preserving newest-saved-first order. */
export async function resolveSavedCandidates(db: Db, saved: readonly SubjectRef[]): Promise<Candidate[]> {
  const { placeById, eventById, happeningById } = await loadSubjects(db, saved);

  const now = new Date();
  const out: Candidate[] = [];

  for (const s of saved) {
    if (s.subject_type === "place") {
      const place = placeById.get(s.subject_id);
      if (!place) continue;
      out.push({
        generator: "saved_pick",
        baseScore: 50,
        score: 50,
        subject: { type: "place", id: place.id },
        pill: "Saved",
        why: "You saved this",
        headline: place.name ?? "Saved place",
        detail: place.detail_line ?? "",
        primaryAction: { label: "Saved", kind: "add" },
        image: placeImage(place),
        urgency: "low",
        validFrom: now.toISOString(),
        validUntil: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
        distanceKm: null,
        subjectName: place.name ?? "Saved place",
        coords: placeCoords(place),
        railTitle: "You saved these",
        railMeta: "from your saves",
      });
    } else if (s.subject_type === "event") {
      const event = eventById.get(s.subject_id);
      if (!event) continue;
      const title = eventHeadline(event.name, CITY.name);
      // A saved event stays after it's happened, clearly marked — same
      // treatment as a saved happening below.
      const eventEnded = eventHasEnded(event, now);
      out.push({
        generator: "saved_pick",
        baseScore: 50,
        score: 50,
        subject: { type: "event", id: event.id },
        pill: eventEnded ? "Ended" : "Saved",
        why: eventEnded ? "This event has passed" : "You saved this",
        headline: title,
        detail: eventEnded ? "Already happened" : (venueLabel(event.venue_name) ?? ""),
        primaryAction: { label: "Saved", kind: "add" },
        image: { url: event.image_url, quality: event.image_url ? "thin" : "none" },
        urgency: "low",
        validFrom: now.toISOString(),
        validUntil: event.starts_at,
        distanceKm: null,
        subjectName: title,
        coords: placeCoords(event),
        railTitle: "You saved these",
        railMeta: "from your saves",
      });
    } else if (s.subject_type === "happening") {
      const h = happeningById.get(s.subject_id);
      if (!h) continue;
      // A saved offer that has since gone dormant/retired — or whose dates
      // have simply passed while still marked live — stays in the list,
      // clearly marked, instead of silently disappearing.
      const ended = h.status !== "live" || happeningHasEnded(h, now);
      out.push({
        generator: "saved_pick",
        baseScore: 50,
        score: 50,
        subject: { type: "happening", id: h.id },
        pill: ended ? "Ended" : "Saved",
        why: ended ? "This offer has ended" : "You saved this",
        headline: h.title,
        detail: ended ? "No longer running" : (h.venue_name ?? ""),
        primaryAction: { label: "Saved", kind: "add" },
        image: { url: h.image_url, quality: h.image_url ? "thin" : "none" },
        urgency: "low",
        validFrom: now.toISOString(),
        validUntil: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
        distanceKm: null,
        subjectName: h.title,
        coords: placeCoords(h),
        railTitle: "You saved these",
        railMeta: "from your saves",
      });
    }
    // Any other subject_type ("reel" / "experience" / "itinerary_item" /
    // "practicality" — leftover rows from removed features, see this file's
    // header) has no batch id-lookup pool here; this if/else chain simply
    // falls through and skips it.
  }

  return out;
}
