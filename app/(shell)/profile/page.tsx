"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { getProfile, upsertProfile, uploadAvatar } from "@/lib/db";
import type { Profile } from "@/lib/types";
import type { Candidate } from "@/lib/now/types";
import { useInfiniteList } from "@/lib/useInfiniteList";
import { invalidate } from "@/lib/http/clientCache";
import { Button, BottomSheet, Card, Chip, Icon, PageHeader, SectionHeader, SmartImage, Toggle } from "@/components/ui";
import { FomoCard } from "@/components/fomo/Card";
import { FomoSpot } from "@/components/fomo/FomoSpot";
import { WHO_GROUP_LABEL, WHO_GROUP_ORDER, type DealWhoGroup } from "@/lib/happenings/groups";
import { useDealProfile, subscribeSavedChanges } from "@/lib/useSaved";
import { NOTIFY_ME_ENABLED } from "@/lib/happenings/book-early";
import { ensurePushSubscribed, pushReasonMessage, pushSupportReason } from "@/lib/push/client";

const AvatarCropModal = dynamic(() => import("@/components/fomo/AvatarCropModal").then((mod) => mod.AvatarCropModal), {
  ssr: false,
});

// One /api/saved page's worth of rows — matches /api/discover's own default
// page size, same convention the old standalone /saved page used before its
// "Saved" section moved onto Profile (app/(shell)/saved/page.tsx now just
// redirects to /profile#saved).
const SAVED_PAGE_SIZE = 24;

// lib/http/clientCache.ts key for the Saved section's first page — a fixed
// key (not per-user) is fine: the cache is wiped entirely on SIGNED_OUT (see
// clientCache.ts), so it never survives across accounts on a shared device.
const SAVED_CACHE_KEY = "saved:page0";

interface SavedApiResponse {
  items: Candidate[];
}

const SAVED_GROUP_LABELS: { type: Candidate["subject"]["type"]; label: string }[] = [
  { type: "happening", label: "Deals & things to do" },
  { type: "place", label: "Places" },
  { type: "event", label: "Events" },
  { type: "experience", label: "Experiences" },
];

export default function ProfilePage() {
  const db = supabaseBrowserAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const { who, setWho } = useDealProfile();
  const [whoError, setWhoError] = useState<string | null>(null);
  // "Big on-sale alerts" (supabase/add_push_alerts.sql) — a top-level
  // profiles column, not part of notification_settings (see that
  // migration's own doc comment for why). Toggling it on ensures a push
  // subscription exists for this device before saving, since the setting is
  // meaningless without one.
  const [bigOnsaleAlerts, setBigOnsaleAlerts] = useState(false);
  const [bigOnsaleAlertsBusy, setBigOnsaleAlertsBusy] = useState(false);
  const [bigOnsaleAlertsError, setBigOnsaleAlertsError] = useState<string | null>(null);
  // Lazily read once on mount purely for display ("Notifications:
  // allowed/blocked/not requested yet") — never drives requestPermission
  // itself, which only ever runs from ensurePushSubscribed inside a real
  // button click. A lazy initializer rather than an effect: this is a
  // one-time synchronous browser API read, not a subscription to an
  // external system, so there's nothing to synchronize on mount.
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(
    () => (typeof window === "undefined" ? "unsupported" : pushSupportReason() ? "unsupported" : Notification.permission)
  );
  // Account identity — replaces the old device-id display now that identity
  // comes from a real Supabase session rather than a localStorage device id.
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [accountIdCopied, setAccountIdCopied] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarPendingFile, setAvatarPendingFile] = useState<{ src: string; name: string } | null>(
    null
  );
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Saved (moved here from the old standalone /saved page — see this file's
  // "Saved" section below). Reads through the same GET /api/saved the old
  // page used, grouped by subject type for display.
  const {
    items: savedCandidates,
    loading: savedLoading,
    loadingMore: savedLoadingMore,
    hasMore: savedHasMore,
    sentinelRef: savedSentinelRef,
  } = useInfiniteList<Candidate>(
    {
      pageSize: SAVED_PAGE_SIZE,
      getId: (c) => `${c.subject.type}:${c.subject.id}`,
      onError: (err, phase) =>
        console.error(`[profile] saved ${phase === "initial" ? "load" : "load more"} failed`, err),
      fetchPage: async ({ limit, offset }) => {
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        const res = await fetch(`/api/saved?${params.toString()}`);
        const data = (await res.json()) as SavedApiResponse;
        return data.items ?? [];
      },
      // Seeds page 1 from lib/http/clientCache.ts so a repeat visit to
      // Profile shows the caller's saved items instantly instead of the
      // hourglass spinner below — see lib/useInfiniteList.ts's `cacheKey`.
      cacheKey: SAVED_CACHE_KEY,
    },
    [db]
  );

  // A save/unsave anywhere in the app (this page's grid, a card on Home, a
  // reel, …) goes through the one shared lib/useSaved.ts store — invalidate
  // this page's cached page 1 whenever that set changes so it revalidates
  // instead of showing a stale saved/unsaved state on the next visit here.
  useEffect(() => {
    return subscribeSavedChanges(() => invalidate(SAVED_CACHE_KEY));
  }, []);

  const savedGroups = useMemo(() => {
    return SAVED_GROUP_LABELS.map(({ type, label }) => ({
      type,
      label,
      items: savedCandidates.filter((c) => c.subject.type === type),
    })).filter((g) => g.items.length > 0);
  }, [savedCandidates]);

  function pickAvatarFile() {
    setAvatarOpen(false);
    avatarInputRef.current?.click();
  }

  function handleAvatarSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file next time
    if (!file) return;
    setAvatarError(null);
    // Don't upload the raw file — open the crop step first.
    const src = URL.createObjectURL(file);
    setAvatarPendingFile({ src, name: file.name });
  }

  function cancelAvatarCrop() {
    if (avatarPendingFile) URL.revokeObjectURL(avatarPendingFile.src);
    setAvatarPendingFile(null);
  }

  async function handleAvatarCropped(croppedFile: File) {
    if (avatarPendingFile) URL.revokeObjectURL(avatarPendingFile.src);
    setAvatarPendingFile(null);
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return;
    setAvatarUploading(true);
    setAvatarError(null);
    try {
      const avatarUrl = await uploadAvatar(db, user.id, croppedFile);
      const updated = await upsertProfile(db, { avatar_url: avatarUrl });
      setProfile(updated);
    } catch (err) {
      console.error("[profile] avatar upload failed", err);
      setAvatarError(err instanceof Error ? err.message : "Upload failed — try again.");
    } finally {
      setAvatarUploading(false);
    }
  }

  async function removeAvatar() {
    setAvatarOpen(false);
    try {
      const updated = await upsertProfile(db, { avatar_url: null });
      setProfile(updated);
    } catch (err) {
      console.error("[profile] remove avatar failed", err);
      setAvatarError("Couldn't remove photo — try again.");
    }
  }

  /**
   * Turning this on both flips the DB column AND (unlike every other toggle
   * on this screen) ensures a live push subscription for this device first —
   * `big_onsale_alerts = true` with no subscription would just be a setting
   * that silently never fires. Turning it off is a plain column write; an
   * existing subscription is left alone since the user may still have
   * per-item alerts relying on it.
   */
  async function handleBigOnsaleAlertsChange(value: boolean) {
    setBigOnsaleAlertsError(null);
    if (!value) {
      setBigOnsaleAlerts(false);
      upsertProfile(db, { big_onsale_alerts: false }).catch((err) => {
        console.error("[profile] save big_onsale_alerts failed", err);
      });
      return;
    }
    setBigOnsaleAlertsBusy(true);
    try {
      const result = await ensurePushSubscribed();
      if (!result.ok) {
        setBigOnsaleAlertsError(pushReasonMessage(result.reason) ?? "Couldn't turn on alerts — try again.");
        return;
      }
      await upsertProfile(db, { big_onsale_alerts: true });
      setBigOnsaleAlerts(true);
      setNotificationPermission(Notification.permission);
    } catch (err) {
      console.error("[profile] save big_onsale_alerts failed", err);
      setBigOnsaleAlertsError("Couldn't turn on alerts — try again.");
    } finally {
      setBigOnsaleAlertsBusy(false);
    }
  }

  async function copyAccountId() {
    const value = accountEmail ?? accountId;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setAccountIdCopied(true);
      setTimeout(() => setAccountIdCopied(false), 1500);
    } catch (err) {
      console.error("[profile] copy account id failed", err);
    }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([getProfile(db), db.auth.getUser()])
      .then(([profileRow, { data: userData }]) => {
        if (cancelled) return;
        setProfile(profileRow);
        setAccountEmail(userData.user?.email ?? null);
        setAccountId(userData.user?.id ?? null);
        setBigOnsaleAlerts(profileRow?.big_onsale_alerts ?? false);
      })
      .catch((err) => {
        // Fresh device / Supabase not configured yet shouldn't crash the
        // screen — fall back to defaults and log for debugging.
        console.warn("[fomo] profile load failed", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [db]);

  const displayName = profile?.display_name ?? accountEmail?.split("@")[0] ?? "You";

  function toggleWho(group: DealWhoGroup) {
    setWhoError(null);
    const next = who.includes(group) ? who.filter((g) => g !== group) : [...who, group];
    setWho(next).catch((err) => {
      console.error("[profile] save deals profile failed", err);
      setWhoError("Couldn't save that — try again.");
    });
  }

  async function handleResetConfirm() {
    // "Reset app data" pre-auth used to just clear the device-id localStorage
    // key; now that identity is a real Supabase session, this control is
    // relabelled "Sign out" and just does that.
    try {
      await db.auth.signOut();
    } catch (err) {
      console.error("[profile] sign out failed", err);
    }
    router.push("/welcome");
  }

  return (
    <main className="mx-auto flex max-w-[480px] flex-col gap-6 pb-8">
      <PageHeader title="Profile" />

      {loading ? (
        <div className="flex flex-col items-center gap-3 px-5 py-16 text-on-surface-variant">
          <Icon name="hourglass_top" size={28} />
          <p className="text-body-md">Loading your profile…</p>
        </div>
      ) : (
        <>
          {/* Identity */}
          <section className="flex flex-col items-center gap-3 px-5 text-center">
            <div className="relative">
              <div className="h-28 w-28 overflow-hidden rounded-full border-4 border-surface-container shadow-lg">
                {profile?.avatar_url ? (
                  <SmartImage
                    src={profile.avatar_url}
                    alt={displayName}
                    width={112}
                    height={112}
                    priority
                    className="h-full w-full object-cover"
                    onError={() => {
                      // A broken storage URL (e.g. an un-encoded path) fails
                      // to load silently for <img> — surface it and fall
                      // back to the placeholder instead of a blank circle.
                      setAvatarError("Couldn't load your photo — try uploading it again.");
                      setProfile((prev) => (prev ? { ...prev, avatar_url: null } : prev));
                    }}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-surface-container text-on-surface-variant">
                    <Icon name="person" size={48} />
                  </div>
                )}
                {avatarUploading ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-primary/30">
                    <Icon
                      name="progress_activity"
                      size={28}
                      className="animate-spin text-on-primary"
                    />
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                aria-label={profile?.avatar_url ? "Change profile photo" : "Add profile photo"}
                disabled={avatarUploading}
                onClick={() => (profile?.avatar_url ? setAvatarOpen(true) : pickAvatarFile())}
                className="absolute bottom-0 left-0 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-on-primary shadow-md transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                <Icon name="photo_camera" size={16} />
              </button>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleAvatarSelected}
                className="hidden"
              />
            </div>
            {avatarError ? <p className="text-label-sm text-error">{avatarError}</p> : null}
            <h2 className="text-headline-md text-primary">{displayName}</h2>
          </section>

          <div className="flex flex-col gap-4 px-5">
            {/* Deals for you — which concessions this person can use. Drives
                the "You qualify" badges on feed cards, the Home pick, and
                Ask Fomo (lib/useSaved.ts, lib/happenings/hero.ts). */}
            <Card>
              <h3 className="mb-1 flex items-center gap-2 text-headline-sm text-primary">
                <Icon name="sell" className="text-secondary" />
                Deals for you
              </h3>
              <p className="mb-4 text-body-md text-on-surface-variant">
                Pick any that apply. Fomo flags offers you qualify for and puts them first.
              </p>
              <div className="flex flex-wrap gap-2">
                {WHO_GROUP_ORDER.map((group) => {
                  const selected = who.includes(group);
                  return (
                    <Chip
                      key={group}
                      label={WHO_GROUP_LABEL[group]}
                      selected={selected}
                      leadingIcon={selected ? "check" : undefined}
                      aria-pressed={selected}
                      onClick={() => toggleWho(group)}
                    />
                  );
                })}
              </div>
              {whoError ? <p className="mt-3 text-label-sm text-error">{whoError}</p> : null}
            </Card>
          </div>

          {/* Saved — moved here from the old standalone /saved page/nav tab;
              Deals took that bottom-nav slot (components/shell/BottomNav.tsx).
              /saved still works as a redirect to #saved for old links. */}
          <section id="saved" className="flex flex-col gap-4 px-5 scroll-mt-16">
            <SectionHeader title="Saved" />
            {savedLoading ? (
              <div className="flex justify-center py-8">
                <Icon name="hourglass_top" size={24} className="animate-pulse text-primary" />
              </div>
            ) : savedCandidates.length === 0 ? (
              <Card>
                <div className="flex flex-col items-center gap-2 py-6 text-center">
                  <FomoSpot mood="meh" pose="shrug" className="h-20 w-20" />
                  <p className="text-body-md text-on-surface-variant">
                    Tap the bookmark on any deal, event or place to save it here.
                  </p>
                </div>
              </Card>
            ) : (
              <div className="flex flex-col gap-5">
                {savedGroups.map((group) => (
                  <div key={group.type}>
                    <p className="mb-2 text-label-md font-bold text-on-surface-variant">{group.label}</p>
                    <div className="grid grid-cols-2 gap-3">
                      {group.items.map((item) => (
                        <FomoCard
                          key={`${item.subject.type}:${item.subject.id}`}
                          candidate={item}
                          variant="grid"
                        />
                      ))}
                    </div>
                  </div>
                ))}
                {savedHasMore ? (
                  <div ref={savedSentinelRef} className="flex justify-center py-2">
                    {savedLoadingMore ? (
                      <Icon name="hourglass_top" size={20} className="animate-pulse text-primary" />
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </section>

          {/* Account Settings */}
          <section className="flex flex-col gap-4 px-5">
            <h3 className="text-headline-sm text-primary">Account Settings</h3>
            <Card noPadding className="divide-y divide-outline-variant/40">
              <button
                type="button"
                onClick={() => setNotifOpen(true)}
                className="flex w-full items-center justify-between p-4 text-left"
              >
                <span className="flex items-center gap-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-container/10 text-primary">
                    <Icon name="notifications" />
                  </span>
                  <span className="text-body-lg text-primary">Notifications</span>
                </span>
                <Icon name="chevron_right" className="text-on-surface-variant" />
              </button>
              <button
                type="button"
                onClick={() => setSecurityOpen(true)}
                className="flex w-full items-center justify-between p-4 text-left"
              >
                <span className="flex items-center gap-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-container/10 text-primary">
                    <Icon name="shield_person" />
                  </span>
                  <span className="text-body-lg text-primary">Account Security</span>
                </span>
                <Icon name="chevron_right" className="text-on-surface-variant" />
              </button>
              <button
                type="button"
                onClick={() => setResetOpen(true)}
                className="flex w-full items-center gap-4 p-4 text-left"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-error-container/40 text-error">
                  <Icon name="logout" />
                </span>
                <span className="text-body-lg text-error">Sign out</span>
              </button>
            </Card>
            <p className="px-1 text-label-sm text-on-surface-variant">
              &quot;Sign out&quot; signs you out of your Fomo account on this device.
            </p>
          </section>
        </>
      )}

      <BottomSheet open={avatarOpen} onClose={() => setAvatarOpen(false)} title="Profile photo">
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={pickAvatarFile}
            className="flex items-center gap-4 rounded-lg p-3 text-left hover:bg-surface-container-low"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-container/10 text-primary">
              <Icon name="photo_camera" />
            </span>
            <span className="text-body-lg text-primary">Choose new photo</span>
          </button>
          <button
            type="button"
            onClick={() => void removeAvatar()}
            className="flex items-center gap-4 rounded-lg p-3 text-left hover:bg-surface-container-low"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-error-container/40 text-error">
              <Icon name="delete" />
            </span>
            <span className="text-body-lg text-error">Remove photo</span>
          </button>
        </div>
      </BottomSheet>

      <BottomSheet open={resetOpen} onClose={() => setResetOpen(false)} title="Sign out of Fomo?">
        <div className="flex flex-col gap-4">
          <p className="text-body-md text-on-surface-variant">
            You&apos;ll need to sign in again to see your saved things.
          </p>
          <div className="flex gap-3">
            <Button variant="ghost" fullWidth onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button variant="outline" fullWidth onClick={handleResetConfirm}>
              Sign out
            </Button>
          </div>
        </div>
      </BottomSheet>

      <BottomSheet open={notifOpen} onClose={() => setNotifOpen(false)} title="Notifications">
        <div className="flex flex-col gap-5">
          {NOTIFY_ME_ENABLED ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-4">
                <span className="flex flex-col">
                  <span className="text-body-lg text-on-surface">Big on-sale alerts</span>
                  <span className="text-label-sm text-on-surface-variant">
                    Push notifications for the fastest-selling Book early events, even without
                    tapping Notify me on each one
                  </span>
                </span>
                <Toggle
                  checked={bigOnsaleAlerts}
                  onChange={(value) => void handleBigOnsaleAlertsChange(value)}
                  disabled={bigOnsaleAlertsBusy}
                  id="notif-big-onsale-alerts"
                />
              </div>
              {bigOnsaleAlertsError ? (
                <p className="text-label-sm text-error">{bigOnsaleAlertsError}</p>
              ) : (
                <p className="text-label-sm text-on-surface-variant">
                  Notifications:{" "}
                  {notificationPermission === "granted"
                    ? "allowed"
                    : notificationPermission === "denied"
                      ? "blocked — enable them in your browser settings"
                      : notificationPermission === "unsupported"
                        ? "not supported on this device/browser"
                        : "not requested yet"}
                </p>
              )}
            </div>
          ) : (
            <p className="text-body-md text-on-surface-variant">
              Push alerts for big on-sale dates are coming soon.
            </p>
          )}
        </div>
      </BottomSheet>

      <BottomSheet
        open={securityOpen}
        onClose={() => setSecurityOpen(false)}
        title="Account Security"
      >
        <div className="flex flex-col gap-4">
          <p className="text-body-md text-on-surface-variant">
            Your Fomo account is tied to a real login now — this is the identity behind it.
          </p>
          <div className="flex flex-col gap-3 rounded-lg bg-surface-container-low p-4">
            <div className="flex flex-col gap-1">
              <span className="text-label-sm text-on-surface-variant">Account</span>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-body-md text-on-surface">
                  {accountEmail ?? accountId ?? "—"}
                </span>
                <button
                  type="button"
                  onClick={copyAccountId}
                  aria-label="Copy account email"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container active:bg-surface-container-high"
                >
                  <Icon name={accountIdCopied ? "check" : "content_copy"} size={18} />
                </button>
              </div>
            </div>
            {profile?.created_at ? (
              <div className="flex flex-col gap-1">
                <span className="text-label-sm text-on-surface-variant">Linked since</span>
                <span className="text-body-md text-on-surface">
                  {new Date(profile.created_at).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              </div>
            ) : null}
          </div>
          <Button
            variant="outline"
            fullWidth
            leadingIcon="logout"
            onClick={() => {
              setSecurityOpen(false);
              setResetOpen(true);
            }}
          >
            Sign out
          </Button>
        </div>
      </BottomSheet>

      {avatarPendingFile ? (
        <AvatarCropModal
          imageSrc={avatarPendingFile.src}
          fileName={avatarPendingFile.name}
          onCancel={cancelAvatarCrop}
          onConfirm={(file) => void handleAvatarCropped(file)}
        />
      ) : null}
    </main>
  );
}
