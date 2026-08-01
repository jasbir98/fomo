import { supabase } from "@/lib/supabase";
import type { ChatMessage, ChatMessageInsert } from "@/lib/types";

/** List chat messages for a trip, oldest first, scoped to the device. */
export async function listMessages(
  deviceId: string,
  tripId: string
): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("device_id", deviceId)
    .eq("trip_id", tripId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Insert a chat message (user or assistant turn) for a device+trip. */
export async function addMessage(
  deviceId: string,
  message: Omit<ChatMessageInsert, "device_id">
): Promise<ChatMessage> {
  const { data, error } = await supabase
    .from("chat_messages")
    .insert({ device_id: deviceId, ...message })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/** Delete all chat messages for a trip, scoped to the device. */
export async function clearMessages(
  deviceId: string,
  tripId: string
): Promise<void> {
  const { error } = await supabase
    .from("chat_messages")
    .delete()
    .eq("device_id", deviceId)
    .eq("trip_id", tripId);
  if (error) throw error;
}
