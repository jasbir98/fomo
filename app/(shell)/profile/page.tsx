"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { getProfile, upsertProfile, uploadAvatar } from "@/lib/db";
import type { Profile } from "@/lib/types";
import { Button, BottomSheet, Card, Icon, PageHeader, SmartImage, Toggle } from "@/components/ui";
import { NOTIFY_ME_ENABLED } from "@/lib/happenings/book-early";
import { ensurePushSubscribed, pushReasonMessage, pushSupportReason } from "@/lib/push/client";
import { MakeFomoYours } from "@/components/personalise/MakeFomoYours";
import { INTEREST_LABEL } from "@/lib/personalise/interests";
import { usePrefs } from "@/lib/personalise/usePrefs";

const AvatarCropModal = dynamic(() => import("@/components/fomo/AvatarCropModal").then((mod) => mod.AvatarCropModal), {
  ssr: false,
});

const subscribeNoop = () => () => {};

export default function ProfilePage() {
  const db = supabaseBrowserAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const prefs = usePrefs();
  const [mfyOpen, setMfyOpen] = useState(false);
  // "Big on-sale alerts" (supabase/archive/add_push_alerts.sql) — a top-level
  // profiles column, not part of notification_settings (see that
  // migration's own doc comment for why). Toggling it on ensures a push
  // subscription exists for this device before saving, since the setting is
  // meaningless without one.
  const [bigOnsaleAlerts, setBigOnsaleAlerts] = useState(false);
  const [bigOnsaleAlertsBusy, setBigOnsaleAlertsBusy] = useState(false);
  const [bigOnsaleAlertsError, setBigOnsaleAlertsError] = useState<string | null>(null);
  // Read purely for display ("Notifications: allowed/blocked/not requested
  // yet") — never drives requestPermission itself, which only ever runs from
  // ensurePushSubscribed inside a real button click. useSyncExternalStore
  // with an "unsupported" server snapshot keeps the hydration pass identical
  // to the server HTML; the real value renders right after.
  const initialPermission = useSyncExternalStore(
    subscribeNoop,
    () => (pushSupportReason() ? "unsupported" : Notification.permission),
    () => "unsupported" as const
  );
  const [permissionOverride, setNotificationPermission] = useState<NotificationPermission | "unsupported" | null>(null);
  const notificationPermission = permissionOverride ?? initialPermission;
  // Account identity — replaces the old device-id display now that identity
  // comes from a real Supabase session rather than a localStorage device id.
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [accountIdCopied, setAccountIdCopied] = useState(false);
  const [googlePhotoUrl, setGooglePhotoUrl] = useState<string | null>(null);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarPendingFile, setAvatarPendingFile] = useState<{ src: string; name: string } | null>(
    null
  );
  const avatarInputRef = useRef<HTMLInputElement>(null);

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
      setAvatarError(err instanceof Error ? err.message : "Upload failed. Try again.");
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
      setAvatarError("Couldn't remove photo. Try again.");
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
        setBigOnsaleAlertsError(pushReasonMessage(result.reason) ?? "Couldn't turn on alerts. Try again.");
        return;
      }
      await upsertProfile(db, { big_onsale_alerts: true });
      setBigOnsaleAlerts(true);
      setNotificationPermission(Notification.permission);
    } catch (err) {
      console.error("[profile] save big_onsale_alerts failed", err);
      setBigOnsaleAlertsError("Couldn't turn on alerts. Try again.");
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
        // Extract Google profile photo from Supabase user_metadata if available
        // Supabase stores it in avatar_url or picture depending on the OAuth flow
        const metadata = userData.user?.user_metadata;
        const googlePhoto = (metadata?.avatar_url || metadata?.picture) as string | null;
        setGooglePhotoUrl(googlePhoto ?? null);
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

  /** "Student · under 26 · EH · into comedy, gigs · under £10" (task brief §2's
   *  own example) — built from whichever pieces are actually set, in that
   *  order, comma-joining the interests but dot-joining everything else
   *  (matches the brief's example literally). `null` (never answered at
   *  all) renders a plain "Not set up yet" instead of an empty summary. */
  function prefsSummary(): string {
    const parts: string[] = [];
    if (prefs.status === "student") parts.push("Student");
    else if (prefs.status === "working") parts.push("Working");
    if (prefs.under26) parts.push("under 26");
    if (prefs.residents) parts.push("EH");
    if (prefs.over60) parts.push("over 60");
    if (prefs.interests.length > 0) {
      parts.push(`into ${prefs.interests.map((i) => INTEREST_LABEL[i].toLowerCase()).join(", ")}`);
    }
    if (prefs.budget === "free") parts.push("free only");
    else if (prefs.budget === "under10") parts.push("under £10");
    return parts.length > 0 ? parts.join(" · ") : "Not set up yet. Tell Fomo what you're into.";
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
    router.push("/");
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
                      setAvatarError("Couldn't load your photo. Try uploading it again.");
                      setProfile((prev) => (prev ? { ...prev, avatar_url: null } : prev));
                    }}
                  />
                ) : googlePhotoUrl ? (
                  <SmartImage
                    src={googlePhotoUrl}
                    alt={displayName}
                    width={112}
                    height={112}
                    priority
                    className="h-full w-full object-cover"
                    onError={() => {
                      // Couldn't load Google profile photo — just show placeholder
                      setGooglePhotoUrl(null);
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
            {/* Make Fomo yours — replaces the old 4-chip "Deals for you"
                selector (task brief). Drives the "You qualify" badges on
                feed cards, the Home pick, Ask Fomo AND the ranking boost
                (lib/personalise/score.ts) — see lib/personalise/usePrefs.ts
                for the full shape; `who` (lib/useSaved.ts's `fomo_who`) is
                still what the badges themselves read, derived from this. */}
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="flex items-center gap-2 text-headline-sm text-primary">
                    <Icon name="tune" className="text-secondary" />
                    Make Fomo yours
                  </h3>
                  <p className="text-body-md text-on-surface-variant">{prefsSummary()}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setMfyOpen(true)} className="shrink-0">
                  Edit
                </Button>
              </div>
            </Card>
          </div>

          <MakeFomoYours open={mfyOpen} onClose={() => setMfyOpen(false)} />

          {/* Saved — now a dedicated page at /saved with its own AppHeader.
              The bottom-nav Saved tab points there. */}
          <section className="flex flex-col gap-4 px-5">
            <a
              href="/saved"
              className="flex w-full items-center justify-between p-4 text-left"
            >
              <span className="flex items-center gap-4">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-container/10 text-primary">
                  <Icon name="bookmark" />
                </span>
                <span className="text-body-lg text-primary">Saved</span>
              </span>
              <Icon name="chevron_right" className="text-on-surface-variant" />
            </a>
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
              <a
                href="/tip"
                className="flex w-full items-center justify-between p-4 text-left"
              >
                <span className="flex items-center gap-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-container/10 text-primary">
                    <Icon name="lightbulb" />
                  </span>
                  <span className="text-body-lg text-primary">Tip us off</span>
                </span>
                <Icon name="chevron_right" className="text-on-surface-variant" />
              </a>
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
            <p className="flex items-center gap-3 px-1 text-label-sm text-on-surface-variant">
              <Link href="/privacy" className="underline underline-offset-2">
                Privacy
              </Link>
              <Link href="/terms" className="underline underline-offset-2">
                Terms
              </Link>
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
                      ? "blocked. Turn them on in your browser settings"
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
            Your Fomo account is tied to a real login now. This is the identity behind it.
          </p>
          <div className="flex flex-col gap-3 rounded-lg bg-surface-container-low p-4">
            <div className="flex flex-col gap-1">
              <span className="text-label-sm text-on-surface-variant">Account</span>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-body-md text-on-surface">
                  {accountEmail ?? accountId ?? "–"}
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
