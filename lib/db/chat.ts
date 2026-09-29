import type { Db } from "@/lib/supabase/types";
import type { ChatMessage, ChatMessageInsert } from "@/lib/types";

/**
 * Chat history for the signed-in caller. `chat_messages.user_id` carries an
 * `own_rows` RLS policy (supabase/archive/harden_rls.sql), so a plain,
 * unfiltered query is already scoped to the caller — same convention as
 * lib/db/saved.ts's `listSavedItems`.
 */
export async function listMessages(db: Db): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from("chat_messages")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Insert a chat message (user or assistant turn). */
export async function addMessage(db: Db, message: ChatMessageInsert): Promise<ChatMessage> {
  const { data, error } = await db.from("chat_messages").insert({ ...message }).select("*").single();
  if (error) throw error;
  return data;
}

/**
 * Delete all of the signed-in caller's chat messages. RLS's `own_rows` policy
 * is what actually restricts this; the always-true `.not(...)` only satisfies
 * the database's safe-update check, which rejects a DELETE with no WHERE
 * clause (code 21000).
 */
export async function clearMessages(db: Db): Promise<void> {
  const { error } = await db.from("chat_messages").delete().not("id", "is", null);
  if (error) throw error;
}
