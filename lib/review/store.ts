import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { StagedDeal } from "./digest";
import type { ReviewPatch, ReviewStore, SupersededPatch } from "./decide";

/** Columns the review page shows. Explicit, so a staging column added later never leaks onto the page. */
const COLUMNS =
  "id,slug,batch_id,created_at,title,summary,time_note,venue_name,saving_label,price_text,source_name,source_url,booking_url," +
  "evidence_quote,quality_score,quality_reasons,extraction_status,approved,happening_id,reviewed_at,reviewed_action,rejected_reason";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The real store: happenings_staging through the service-role client (bypasses
 * RLS; the token check upstream is the gate). Server-only, never in a client bundle.
 */
export function supabaseReviewStore(): ReviewStore {
  return {
    async read(id: string): Promise<StagedDeal | null> {
      if (!UUID_RE.test(id)) return null;
      const { data, error } = await supabaseAdmin().from("happenings_staging").select(COLUMNS).eq("id", id).maybeSingle();
      if (error) throw new Error(`review read failed: ${error.message}`);
      return (data as StagedDeal | null) ?? null;
    },

    async writeIfOpen(id: string, patch: ReviewPatch): Promise<boolean> {
      if (!UUID_RE.test(id)) return false;
      // One atomic UPDATE ... WHERE: matches only while the row is still unreviewed, not live and not
      // already approved or rejected, so a second tap (or a scanner) writes nothing.
      const { data, error } = await supabaseAdmin()
        .from("happenings_staging")
        .update(patch)
        .eq("id", id)
        .is("reviewed_at", null)
        .is("happening_id", null)
        .or("approved.is.null,approved.eq.false")
        // A null status counts as open (the column is nullable), which a bare `not.in` would exclude.
        .or("extraction_status.is.null,extraction_status.not.in.(promoted,approved,rejected)")
        .select("id");
      if (error) throw new Error(`review write failed: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },

    async closeOlderDuplicates(row: StagedDeal, patch: SupersededPatch): Promise<number> {
      // No slug or no created_at: nothing to match "older" against, so close nothing.
      if (!row.slug || !row.created_at || !UUID_RE.test(row.id)) return 0;
      const { data, error } = await supabaseAdmin()
        .from("happenings_staging")
        .update(patch)
        .eq("slug", row.slug)
        .neq("id", row.id)
        .lt("created_at", row.created_at)
        .is("reviewed_at", null)
        .is("happening_id", null)
        .or("approved.is.null,approved.eq.false")
        .or("extraction_status.is.null,extraction_status.not.in.(promoted,approved,rejected)")
        .select("id");
      if (error) throw new Error(`closing older duplicates failed: ${error.message}`);
      return data?.length ?? 0;
    },
  };
}
