"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { User } from "@supabase/supabase-js";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { getProfile } from "@/lib/db/profile";
import type { Profile } from "@/lib/types";
import { avatarUrlOf, displayNameOf } from "./identity";

export type CurrentUserStatus = "loading" | "signed_out" | "signed_in";

export interface CurrentUser {
  status: CurrentUserStatus;
  user: User | null;
  /** Profile name, else the provider's (Google) name. `null` when unknown. */
  name: string | null;
  /** Uploaded avatar, else the provider's photo. `null` when none. */
  avatarUrl: string | null;
}

/**
 * One shared answer to "who is signed in, and what do they look like" — the
 * session plus their `profiles` row, fetched once per page load and read by
 * the header, the side nav and the Profile page alike (same module-store +
 * useSyncExternalStore shape as lib/useSaved.ts). `refreshCurrentUser()`
 * re-reads everything after the Profile page saves a name or photo.
 */
const INITIAL: CurrentUser = { status: "loading", user: null, name: null, avatarUrl: null };
const SIGNED_OUT: CurrentUser = { status: "signed_out", user: null, name: null, avatarUrl: null };
let state: CurrentUser = INITIAL;
const listeners = new Set<() => void>();
let initStarted = false;
/** Bumped per load so a slow, superseded load can't overwrite a newer one. */
let loadId = 0;

function setState(next: CurrentUser): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;
const getServerSnapshot = () => INITIAL;

function build(user: User, profile: Profile | null): CurrentUser {
  return { status: "signed_in", user, name: displayNameOf(profile, user), avatarUrl: avatarUrlOf(profile, user) };
}

async function load(): Promise<void> {
  const id = ++loadId;
  const db = supabaseBrowserAuth();
  const {
    data: { session },
  } = await db.auth.getSession();
  if (id !== loadId) return;
  if (!session) {
    setState(SIGNED_OUT);
    return;
  }
  // Show the provider's name/photo straight away, then upgrade once the
  // profile row (which may hold an uploaded avatar / typed name) lands.
  const user = session.user;
  if (state.user?.id !== user.id || state.status !== "signed_in") setState(build(user, null));
  let profile: Profile | null = null;
  try {
    profile = await getProfile(db);
  } catch (err) {
    console.warn("[auth] profile read failed", err);
  }
  if (id !== loadId) return;
  setState(build(user, profile));
}

/** Re-read the session and profile row — call after saving a name or photo. */
export function refreshCurrentUser(): Promise<void> {
  return load();
}

function ensureInitialized(): void {
  if (initStarted || typeof window === "undefined") return;
  initStarted = true;
  void load();
  supabaseBrowserAuth().auth.onAuthStateChange((event, session) => {
    // SIGNED_IN also re-fires on tab refocus for the same user — nothing to redo then.
    if (event === "SIGNED_IN" && session && state.user?.id === session.user.id) return;
    if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
      // Deferred: awaiting Supabase calls inside this callback can deadlock the auth lock.
      setTimeout(() => void load(), 0);
    }
  });
}

export function useCurrentUser(): CurrentUser {
  useEffect(() => {
    ensureInitialized();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
