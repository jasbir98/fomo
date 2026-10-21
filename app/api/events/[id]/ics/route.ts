/**
 * GET /api/events/[id]/ics — downloads a single-event .ics file for a
 * provider event (Skiddle/Ticketmaster, the `events` table), for the event
 * detail page's "Add to calendar" button
 * (app/(shell)/event/[id]/page.tsx). Same reasoning as
 * app/api/happenings/[id]/ics/route.ts (see that file's doc comment and
 * lib/happenings/ics.ts, which both builders share) — `Content-Disposition:
 * inline` so iOS Safari opens the native "Add Event" sheet directly.
 *
 * Public: proxy.ts matches this one path with a dedicated PUBLIC_EVENT_ICS
 * regex (GET/HEAD only) — bare /api/events (the destination-search route,
 * one directory up) stays behind a session, since it triggers paid Mapbox
 * geocoding + Ticketmaster/Skiddle calls + service-role writes for an
 * arbitrary caller-supplied destination and nothing in the app actually
 * calls it. No cache headers, same reasoning as the happenings ics route:
 * fetched once per tap, not repeatedly, so there's nothing for a cache to
 * usefully save here.
 */
import "server-only";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { captureServerException } from "@/lib/analytics/server-exception";
import { getEvent } from "@/lib/db";
import { buildEventIcs, ICS_CONTENT_TYPE } from "@/lib/happenings/ics";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await supabaseServer();

  try {
    const event = await getEvent(db, id);
    if (!event) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const ics = buildEventIcs(event);
    const filename = `${event.id}.ics`;

    return new NextResponse(ics, {
      headers: {
        "Content-Type": ICS_CONTENT_TYPE,
        "Content-Disposition": `inline; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("[api/events/:id/ics] failed", err);
    await captureServerException(err, {
      path: new URL(request.url).pathname,
      method: request.method,
      headers: request.headers,
      route: "/api/events/[id]/ics",
      handled: true,
    });
    return NextResponse.json({ error: "Failed to build calendar event" }, { status: 500 });
  }
}
