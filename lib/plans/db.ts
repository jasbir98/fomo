/**
 * Reads and writes `plans` (supabase/add_plans.sql). Service role only: the
 * table has RLS on and no policies, so nothing client-side can list plans.
 */
import "server-only";
import { randomInt } from "node:crypto";
import { describeSupabaseError } from "@/lib/db/errors";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Plan, PlanItem } from "./types";

const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const ID_LENGTH = 8;
export const PLAN_ID_RE = /^[A-Za-z0-9]{8}$/;

/** Thrown when the `plans` table doesn't exist yet (add_plans.sql not run). */
export class PlansUnavailableError extends Error {
  constructor() {
    super("plans table missing — run supabase/add_plans.sql");
    this.name = "PlansUnavailableError";
  }
}

function isMissingTable(err: { code?: string } | null): boolean {
  return err?.code === "42P01" || err?.code === "PGRST205";
}

/** 8 chars from an alphabet without look-alikes (0/O, 1/l/I): ~1.3e14 ids. */
function newPlanId(): string {
  let id = "";
  for (let i = 0; i < ID_LENGTH; i += 1) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

async function idForHash(hash: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin().from("plans").select("id").eq("items_hash", hash).maybeSingle();
  if (error) {
    if (isMissingTable(error)) throw new PlansUnavailableError();
    throw new Error(`[plans] lookup by hash failed: ${describeSupabaseError(error)}`);
  }
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Returns the id for these items, reusing the existing plan when the same
 * picks were made before. Retries on the (very unlikely) id collision and
 * on a concurrent insert of the same hash.
 */
export async function savePlan(items: PlanItem[], hash: string): Promise<{ id: string; created: boolean }> {
  const existing = await idForHash(hash);
  if (existing) return { id: existing, created: false };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = newPlanId();
    const { error } = await supabaseAdmin().from("plans").insert({ id, items, items_hash: hash });
    if (!error) return { id, created: true };
    if (isMissingTable(error)) throw new PlansUnavailableError();
    if (error.code === "23505") {
      // Either the same picks were saved a moment ago, or the id collided.
      const raced = await idForHash(hash);
      if (raced) return { id: raced, created: false };
      continue;
    }
    throw new Error(`[plans] insert failed: ${describeSupabaseError(error)}`);
  }
  throw new Error("[plans] could not allocate a plan id");
}

/** A plan by id, or null when it doesn't exist (or the table doesn't yet). */
export async function getPlan(id: string): Promise<Plan | null> {
  if (!PLAN_ID_RE.test(id)) return null;
  const { data, error } = await supabaseAdmin()
    .from("plans")
    .select("id, items, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw new Error(`[plans] read failed: ${describeSupabaseError(error)}`);
  }
  if (!data) return null;
  const row = data as { id: string; items: PlanItem[]; created_at: string };
  return { id: row.id, items: Array.isArray(row.items) ? row.items : [], createdAt: row.created_at };
}
