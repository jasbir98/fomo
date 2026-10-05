"use client";

import { initialsOf } from "@/lib/auth/identity";
import { useCurrentUser } from "@/lib/auth/useCurrentUser";
import { Icon, SmartImage } from "@/components/ui";

/**
 * The signed-in user's round avatar for the header and side nav: their photo
 * (uploaded, else Google's), falling back to brand-coloured initials, then the
 * plain person icon. Fixed 32px so it drops into the old icon's footprint.
 * SmartImage already sends `referrerPolicy="no-referrer"` for
 * googleusercontent (Google 403s some referrers) and renders `fallback` when
 * the photo fails to load.
 */
export function UserAvatar({ size = 32 }: { size?: number }) {
  const { user, name, avatarUrl } = useCurrentUser();
  const initials = initialsOf(name ?? user?.email ?? "");
  const box = "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary-container text-on-primary";
  const placeholder = initials ? (
    <span className="text-label-sm font-bold leading-none" aria-hidden="true">
      {initials}
    </span>
  ) : (
    <Icon name="person" size={Math.round(size * 0.53)} />
  );

  return (
    <span className={box} style={{ width: size, height: size }}>
      {avatarUrl ? (
        <SmartImage
          src={avatarUrl}
          alt=""
          width={size}
          height={size}
          className="h-full w-full object-cover"
          fallback={<span className="flex h-full w-full items-center justify-center">{placeholder}</span>}
        />
      ) : (
        placeholder
      )}
    </span>
  );
}
