/**
 * GET /api/happenings/[id]/ics — downloads a single-event .ics file for the
 * happening's next occurrence, for the detail page's "Add to calendar"
 * button (app/(shell)/happening/[id]/page.tsx). `Content-Disposition: inline`
 * (not `attachment`) so iOS Safari opens the native "Add Event" sheet
 * directly instead of treating it as a file download.
 *
 * Public, same as GET /api/happenings/[id] (proxy.ts's PUBLIC_API_PREFIXES
 * already covers this — `/api/happenings` matches any `/api/happenings/*`
 * path, ics route included, so nothing needed there). No cache headers: a
 * calendar app fetches this once per tap, not repeatedly, so there's
 * nothing here for a browser cache to usefully save.
 */
import "server-only";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { getHappeningById } from "@/lib/db/happenings";
import { nextOccurrences } from "@/lib/happenings/occurrence";
import { buildHappeningIcs, ICS_CONTENT_TYPE } from "@/lib/happenings/ics";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await supabaseServer();

  try {
    const happening = await getHappeningById(db, id);
    if (!happening) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const now = new Date();
    const occurrence = nextOccurrences(happening, now, new Date(now.getTime() + 366 * 86_400_000))[0];
    if (!occurrence) {
      return NextResponse.json({ error: "No upcoming occurrence" }, { status: 404 });
    }

    const ics = buildHappeningIcs(happening, occurrence, now);
    const filename = `${happening.slug || happening.id}.ics`;

    return new NextResponse(ics, {
      headers: {
        "Content-Type": ICS_CONTENT_TYPE,
        "Content-Disposition": `inline; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("[api/happenings/:id/ics] failed", err);
    return NextResponse.json({ error: "Failed to build calendar event" }, { status: 500 });
  }
}
