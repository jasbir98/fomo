"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeviceId } from "@/lib/device";
import {
  deleteTrip,
  getProfile,
  getPreferences,
  getRules,
  listTrips,
  setActiveTrip,
  upsertProfile,
  uploadAvatar,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_PRIVACY_SETTINGS,
} from "@/lib/db";
import type {
  NotificationSettings,
  PrivacySettings,
  Profile,
  TravelPreferences,
  RoameoRules,
  Trip,
} from "@/lib/types";
import { Button, BottomSheet, Card, Chip, ConfirmDialog, Icon, PageHeader, Slider, Toggle } from "@/components/ui";
import { AvatarCropModal } from "@/components/roameo/AvatarCropModal";
import { interestIcon } from "@/lib/interests";

/** Must match STORAGE_KEY in lib/device.ts (not exported from there). */
const DEVICE_ID_STORAGE_KEY = "roameo_device_id";

const DNA_SLIDERS: {
  field: keyof Pick<
    TravelPreferences,
    "luxury_backpacker" | "planned_spontaneous" | "foodie_utilitarian"
  >;
  left: string;
  right: string;
}[] = [
  { field: "luxury_backpacker", left: "Backpacker", right: "Luxury" },
  { field: "planned_spontaneous", left: "Spontaneous", right: "Planned" },
  { field: "foodie_utilitarian", left: "Utilitarian", right: "Foodie" },
];

function formatTripDates(start: string | null, end: string | null): string | null {
  if (!start && !end) return null;
  const short = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const withYear = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  if (start && end) return `${short(start)} – ${withYear(end)}`;
  return withYear((start ?? end) as string);
}

export default function ProfilePage() {
  const deviceId = useDeviceId();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [prefs, setPrefs] = useState<TravelPreferences | null>(null);
  const [rules, setRules] = useState<RoameoRules | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [switchingTrip, setSwitchingTrip] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [pendingDeleteTrip, setPendingDeleteTrip] = useState<Trip | null>(null);
  const [deletingTrip, setDeletingTrip] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [notifSettings, setNotifSettings] = useState<NotificationSettings>(
    DEFAULT_NOTIFICATION_SETTINGS
  );
  const [privacySettings, setPrivacySettings] = useState<PrivacySettings>(
    DEFAULT_PRIVACY_SETTINGS
  );
  const [deviceIdCopied, setDeviceIdCopied] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarPendingFile, setAvatarPendingFile] = useState<{ src: string; name: string } | null>(
    null
  );
  const avatarInputRef = useRef<HTMLInputElement>(null);
  // Set true the moment the user touches a notification toggle. Guards
  // against the initial profile-load fetch resolving late and clobbering a
  // just-saved local change with stale/default data (see updateNotifSetting).
  const notifTouchedRef = useRef(false);

  function pickAvatarFile() {
    setAvatarOpen(false);
    avatarInputRef.current?.click();
  }

  function handleAvatarSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file next time
    if (!file || !deviceId) return;
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
    if (!deviceId) return;
    setAvatarUploading(true);
    setAvatarError(null);
    try {
      const avatarUrl = await uploadAvatar(deviceId, croppedFile);
      const updated = await upsertProfile(deviceId, { avatar_url: avatarUrl });
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
    if (!deviceId) return;
    try {
      const updated = await upsertProfile(deviceId, { avatar_url: null });
      setProfile(updated);
    } catch (err) {
      console.error("[profile] remove avatar failed", err);
      setAvatarError("Couldn't remove photo — try again.");
    }
  }

  function updateNotifSetting(key: keyof NotificationSettings, value: boolean) {
    notifTouchedRef.current = true;
    const next = { ...notifSettings, [key]: value };
    setNotifSettings(next);
    if (!deviceId) return;
    upsertProfile(deviceId, { notification_settings: next }).catch((err) => {
      console.error("[profile] save notification_settings failed", err);
    });
  }

  function updatePrivacySetting(key: keyof PrivacySettings, value: boolean) {
    const next = { ...privacySettings, [key]: value };
    setPrivacySettings(next);
    if (!deviceId) return;
    upsertProfile(deviceId, { privacy_settings: next }).catch((err) => {
      console.error("[profile] save privacy_settings failed", err);
    });
  }

  async function copyDeviceId() {
    if (!deviceId) return;
    try {
      await navigator.clipboard.writeText(deviceId);
      setDeviceIdCopied(true);
      setTimeout(() => setDeviceIdCopied(false), 1500);
    } catch (err) {
      console.error("[profile] copy device id failed", err);
    }
  }

  // Make a saved trip the active one, then open the planner on it.
  async function openTrip(tripId: string) {
    if (!deviceId || switchingTrip) return;
    setSwitchingTrip(tripId);
    try {
      await setActiveTrip(deviceId, tripId);
      router.push("/plan");
    } catch (err) {
      console.error("[profile] switch trip failed", err);
      setSwitchingTrip(null);
    }
  }

  async function handleDeleteTrip() {
    if (!deviceId || !pendingDeleteTrip || deletingTrip) return;
    const deletedId = pendingDeleteTrip.id;
    const wasActive = pendingDeleteTrip.status === "active";
    setDeletingTrip(true);
    try {
      await deleteTrip(deviceId, deletedId);
      setTrips((prev) => prev.filter((t) => t.id !== deletedId));
      setPendingDeleteTrip(null);
      // Active trip may have changed (or there may be none left) — reload so
      // every surface (home/map/plan) re-reads the new active trip.
      if (wasActive) window.location.reload();
    } catch (err) {
      console.error("[profile] deleteTrip failed", err);
    } finally {
      setDeletingTrip(false);
    }
  }

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    Promise.all([
      getProfile(deviceId),
      getPreferences(deviceId),
      getRules(deviceId),
      listTrips(deviceId),
    ])
      .then(([profileRow, prefsRow, rulesRow, tripRows]) => {
        if (cancelled) return;
        setProfile(profileRow);
        setPrefs(prefsRow);
        setRules(rulesRow);
        setTrips(tripRows);
        // Merge fetched settings over the defaults (not the other way round)
        // so an older profile row that predates a settings migration and is
        // missing keys still gets every key populated — otherwise a
        // Toggle's `checked` prop could end up `undefined` for a missing key
        // like `trip_reminders`.
        if (!notifTouchedRef.current) {
          setNotifSettings({
            ...DEFAULT_NOTIFICATION_SETTINGS,
            ...(profileRow?.notification_settings ?? {}),
          });
        }
        setPrivacySettings({
          ...DEFAULT_PRIVACY_SETTINGS,
          ...(profileRow?.privacy_settings ?? {}),
        });
      })
      .catch((err) => {
        // Fresh device / Supabase not configured yet shouldn't crash the
        // screen — fall back to defaults and log for debugging.
        console.warn("[roameo] profile load failed", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  const displayName = profile?.display_name ?? "Traveler";
  const tier = profile?.membership_tier ?? "Explorer";
  const rulesLines = (rules?.rules_text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  function handleResetConfirm() {
    try {
      window.localStorage.removeItem(DEVICE_ID_STORAGE_KEY);
    } catch {
      // localStorage unavailable (private mode / blocked) — nothing to clear.
    }
    window.location.reload();
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
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={profile.avatar_url}
                    alt={displayName}
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
              <div className="absolute bottom-0 right-0 rounded-full bg-secondary-container p-1.5 shadow-md">
                <Icon name="verified" filled size={18} className="text-on-secondary-container" />
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
            <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary-container/20 px-4 py-1.5 text-label-md text-on-secondary-container">
              <Icon name="star" filled size={16} />
              {tier}
            </span>
          </section>

          <div className="flex flex-col gap-4 px-5">
            {/* Travel DNA */}
            <Card>
              <div className="mb-5 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-headline-sm text-primary">
                  <Icon name="dns" className="text-secondary" />
                  Travel DNA
                </h3>
                <Link
                  href="/setup/travel-dna?edit=1"
                  className="text-label-md font-medium text-secondary"
                >
                  Edit
                </Link>
              </div>

              <div className="flex flex-col gap-6">
                {DNA_SLIDERS.map(({ field, left, right }) => (
                  <div key={field} className="pointer-events-none">
                    <Slider
                      value={prefs?.[field] ?? 3}
                      onChange={() => {}}
                      leftLabel={left}
                      rightLabel={right}
                      aria-label={`${left} to ${right}`}
                    />
                  </div>
                ))}
              </div>

              <div className="mt-6 flex flex-col gap-3">
                <p className="text-label-md font-bold text-primary">Interests</p>
                {prefs?.interests?.length ? (
                  <div className="flex flex-wrap gap-2">
                    {prefs.interests.map((interest) => (
                      <Chip
                        key={interest}
                        label={interest}
                        selected
                        leadingIcon={interestIcon(interest)}
                        tabIndex={-1}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-body-md text-on-surface-variant">
                    No interests set yet — tap Edit to tell Roameo what you love.
                  </p>
                )}
              </div>
            </Card>

            {/* Roameo Rules */}
            <Card>
              <div className="mb-5 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-headline-sm text-primary">
                  <Icon name="rule" className="text-secondary" />
                  Roameo Rules
                </h3>
                <Link
                  href="/setup/always-remember?edit=1"
                  className="text-label-md font-medium text-secondary"
                >
                  Manage
                </Link>
              </div>

              {rulesLines.length ? (
                <div className="flex flex-col gap-3">
                  {rulesLines.map((line, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-3 rounded-lg border-l-4 border-secondary bg-surface-container-low p-3"
                    >
                      <Icon name="warning" size={20} className="mt-0.5 text-secondary" />
                      <p className="text-body-md text-on-surface-variant">{line}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-body-md text-on-surface-variant">
                  No rules yet — tap Manage to tell Roameo what to always remember.
                </p>
              )}

              {rules?.quick_chips?.length ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {rules.quick_chips.map((chip) => (
                    <Chip key={chip} label={chip} selected tabIndex={-1} />
                  ))}
                </div>
              ) : null}
            </Card>
          </div>

          {/* Saved Trips */}
          <section className="flex flex-col gap-4 px-5">
            <div className="flex items-center justify-between">
              <h3 className="text-headline-sm text-primary">Saved Trips</h3>
              <Link
                href="/plan/new-trip"
                className="flex items-center gap-1 text-label-md font-medium text-secondary"
              >
                <Icon name="add" size={18} />
                New trip
              </Link>
            </div>
            {trips.length ? (
              <div className="-mx-5 flex gap-4 overflow-x-auto px-5 pb-2">
                {trips.map((trip) => {
                  const dates = formatTripDates(trip.start_date, trip.end_date);
                  const active = trip.status === "active";
                  return (
                    <div key={trip.id} className="w-64 shrink-0">
                      <Card noPadding className="relative mb-3 h-40 w-64">
                        <button
                          type="button"
                          onClick={() => openTrip(trip.id)}
                          disabled={switchingTrip !== null}
                          aria-label={`Open ${trip.name ?? trip.destination ?? "trip"}`}
                          className="absolute inset-0 disabled:opacity-70"
                        >
                          {trip.cover_image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={trip.cover_image_url}
                              alt={trip.name ?? "Trip"}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-surface-container text-on-surface-variant">
                              <Icon name="photo" size={32} />
                            </div>
                          )}
                        </button>
                        {active ? (
                          <span className="pointer-events-none absolute left-3 top-3 flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-label-sm font-semibold text-on-primary shadow-sm">
                            <Icon name="check_circle" filled size={14} />
                            Active
                          </span>
                        ) : null}
                        {dates ? (
                          <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-white/90 px-3 py-1 text-label-sm text-primary backdrop-blur-md">
                            {dates}
                          </span>
                        ) : null}
                        {switchingTrip === trip.id ? (
                          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-primary/20">
                            <Icon name="progress_activity" size={28} className="animate-spin text-on-primary" />
                          </span>
                        ) : null}
                        <button
                          type="button"
                          aria-label={`Delete ${trip.name ?? trip.destination ?? "trip"}`}
                          onClick={() => setPendingDeleteTrip(trip)}
                          disabled={switchingTrip !== null}
                          className="absolute bottom-2 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-error shadow-sm backdrop-blur-md transition-colors hover:bg-error-container disabled:opacity-40"
                        >
                          <Icon name="delete" size={16} />
                        </button>
                      </Card>
                      <button
                        type="button"
                        onClick={() => openTrip(trip.id)}
                        disabled={switchingTrip !== null}
                        className="block w-full text-left disabled:opacity-70"
                      >
                        <h4 className="text-headline-sm text-primary">
                          {trip.name ?? "Untitled trip"}
                        </h4>
                        {trip.destination ? (
                          <p className="text-body-md text-on-surface-variant">{trip.destination}</p>
                        ) : null}
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Card>
                <p className="text-body-md text-on-surface-variant">
                  No saved trips yet.{" "}
                  <Link href="/plan/new-trip" className="font-medium text-secondary">
                    Create your first trip
                  </Link>{" "}
                  to start planning.
                </p>
              </Card>
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
                onClick={() => setPrivacyOpen(true)}
                className="flex w-full items-center justify-between p-4 text-left"
              >
                <span className="flex items-center gap-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-container/10 text-primary">
                    <Icon name="lock" />
                  </span>
                  <span className="text-body-lg text-primary">Privacy &amp; Visibility</span>
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
                <span className="text-body-lg text-error">Reset app data</span>
              </button>
            </Card>
            <p className="px-1 text-label-sm text-on-surface-variant">
              No login in v0 — &quot;Log Out&quot; resets this device&apos;s local identity instead.
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

      <BottomSheet open={resetOpen} onClose={() => setResetOpen(false)} title="Reset app data?">
        <div className="flex flex-col gap-4">
          <p className="text-body-md text-on-surface-variant">
            This clears this browser&apos;s local device link. Your trips and preferences stay
            saved in Supabase — reopening the app will start a fresh, empty device profile
            instead of this one.
          </p>
          <div className="flex gap-3">
            <Button variant="ghost" fullWidth onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button variant="outline" fullWidth onClick={handleResetConfirm}>
              Reset
            </Button>
          </div>
        </div>
      </BottomSheet>

      <BottomSheet open={notifOpen} onClose={() => setNotifOpen(false)} title="Notifications">
        <div className="flex flex-col gap-5">
          {(
            [
              {
                key: "trip_reminders",
                label: "Trip reminders",
                desc: "Upcoming itinerary items and check-in times",
              },
              {
                key: "ai_suggestions",
                label: "New AI suggestions",
                desc: "When Roameo finds a place matching your Travel DNA",
              },
              {
                key: "weekly_digest",
                label: "Weekly digest",
                desc: "A weekly summary of new recommendations",
              },
            ] as { key: keyof NotificationSettings; label: string; desc: string }[]
          ).map(({ key, label, desc }) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <span className="flex flex-col">
                <span className="text-body-lg text-on-surface">{label}</span>
                <span className="text-label-sm text-on-surface-variant">{desc}</span>
              </span>
              <Toggle
                checked={notifSettings[key]}
                onChange={(value) => updateNotifSetting(key, value)}
                id={`notif-${key}`}
              />
            </div>
          ))}
        </div>
      </BottomSheet>

      <BottomSheet
        open={privacyOpen}
        onClose={() => setPrivacyOpen(false)}
        title="Privacy & Visibility"
      >
        <div className="flex flex-col gap-5">
          {(
            [
              {
                key: "personalized_recommendations",
                label: "Personalized recommendations",
                desc: "Use your Travel DNA and Roameo Rules to tailor suggestions",
              },
              {
                key: "precise_location",
                label: "Precise location",
                desc: "Use exact GPS instead of city-level location",
              },
              {
                key: "share_usage_data",
                label: "Share anonymous usage data",
                desc: "Help improve Roameo with anonymized usage analytics",
              },
            ] as { key: keyof PrivacySettings; label: string; desc: string }[]
          ).map(({ key, label, desc }) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <span className="flex flex-col">
                <span className="text-body-lg text-on-surface">{label}</span>
                <span className="text-label-sm text-on-surface-variant">{desc}</span>
              </span>
              <Toggle
                checked={privacySettings[key]}
                onChange={(value) => updatePrivacySetting(key, value)}
                id={`privacy-${key}`}
              />
            </div>
          ))}
        </div>
      </BottomSheet>

      <BottomSheet
        open={securityOpen}
        onClose={() => setSecurityOpen(false)}
        title="Account Security"
      >
        <div className="flex flex-col gap-4">
          <p className="text-body-md text-on-surface-variant">
            No login in v0 — this device&apos;s local identity is your account.
          </p>
          <div className="flex flex-col gap-3 rounded-lg bg-surface-container-low p-4">
            <div className="flex flex-col gap-1">
              <span className="text-label-sm text-on-surface-variant">Device ID</span>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-body-md text-on-surface">{deviceId || "—"}</span>
                <button
                  type="button"
                  onClick={copyDeviceId}
                  aria-label="Copy device ID"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container active:bg-surface-container-high"
                >
                  <Icon name={deviceIdCopied ? "check" : "content_copy"} size={18} />
                </button>
              </div>
            </div>
            {profile?.created_at ? (
              <div className="flex flex-col gap-1">
                <span className="text-label-sm text-on-surface-variant">Linked since</span>
                <span className="text-body-md text-on-surface">
                  {new Date(profile.created_at).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
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
            Reset app data
          </Button>
        </div>
      </BottomSheet>

      <ConfirmDialog
        open={pendingDeleteTrip !== null}
        title="Delete this trip?"
        description={`This permanently removes "${
          pendingDeleteTrip?.name ?? pendingDeleteTrip?.destination ?? "this trip"
        }" and its itinerary. This can't be undone.`}
        confirmLabel="Delete trip"
        danger
        busy={deletingTrip}
        onCancel={() => {
          if (!deletingTrip) setPendingDeleteTrip(null);
        }}
        onConfirm={handleDeleteTrip}
      />

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
