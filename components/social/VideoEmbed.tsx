"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui";
import { proxiedThumbnailUrl } from "@/lib/social/media-proxy";

const TIKTOK_ORIGIN = "https://www.tiktok.com";

/**
 * TikTok's *Embed Player* (developers.tiktok.com/doc/embed-player), i.e.
 * `/player/v1/<id>` — NOT the legacy `/embed/v2/<id>` blockquote embed. Only
 * player/v1 speaks the postMessage control API, and it skips the cookie
 * consent interstitial that made v2 embeds fail to play for some visitors.
 *
 * Params deliberately omit `muted`: `muted=1` locks volume changes out, and
 * `muted=0` risks the browser refusing to autoplay at all. We let it autoplay
 * muted (all autoplay policy allows) and unmute via postMessage on a gesture.
 */
const TIKTOK_PARAMS =
  "?autoplay=1&loop=1&controls=1&volume_control=1&progress_bar=0&music_info=0&description=0&rel=0&native_context_menu=0";

/** Whether the user has asked for sound this session, so later reels start unmuted. */
// Key intentionally kept as roameo_... -- renaming would silently reset real users sound preference.
const SOUND_PREF_KEY = "roameo_reel_sound_on";

function readSoundPref(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(SOUND_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSoundPref(on: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SOUND_PREF_KEY, on ? "1" : "0");
  } catch {
    // sessionStorage blocked — preference just won't carry to the next reel.
  }
}

/** Extract a TikTok numeric video id from common video/watch/embed URL shapes. */
function tiktokVideoId(url: string): string | null {
  const match = url.match(/\/(?:video|embed\/v2|player\/v1)\/(\d+)/);
  return match ? match[1] : null;
}

/** Extract an Instagram reel shortcode from common reel/p URL shapes. */
function instagramShortcode(url: string): string | null {
  const match = url.match(/instagram\.com\/(?:reels?|p)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

/** Build an embeddable iframe src for a reel, or null if the URL can't be parsed. */
function buildEmbedUrl(
  platform: string | null,
  videoUrl: string
): { src: string; kind: "tiktok" | "instagram" } | null {
  const lower = `${platform ?? ""} ${videoUrl}`.toLowerCase();
  if (lower.includes("tiktok")) {
    const id = tiktokVideoId(videoUrl);
    return id ? { src: `${TIKTOK_ORIGIN}/player/v1/${id}${TIKTOK_PARAMS}`, kind: "tiktok" } : null;
  }
  if (lower.includes("instagram")) {
    const code = instagramShortcode(videoUrl);
    return code ? { src: `https://www.instagram.com/reel/${code}/embed`, kind: "instagram" } : null;
  }
  return null;
}

export type VideoEmbedProps = {
  platform: string | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  caption?: string | null;
  className?: string;
};

/**
 * Renders a reel as a TikTok/Instagram iframe embed, with `thumbnailUrl` as a
 * poster shown underneath until the iframe finishes loading. If `videoUrl`
 * can't be parsed into an embeddable id/shortcode, falls back to the
 * thumbnail with an "Open on <platform>" link out to the source.
 *
 * Sound: embeds must autoplay muted (browser autoplay policy). For TikTok we
 * drive the documented embed-player postMessage API to unmute on tap and
 * mirror the player's real mute state back into the button. Instagram's embed
 * exposes no such API, so it gets no sound control.
 */
export function VideoEmbed({
  platform,
  videoUrl,
  thumbnailUrl,
  caption,
  className = "",
}: VideoEmbedProps) {
  const embed = videoUrl ? buildEmbedUrl(platform, videoUrl) : null;
  const embedUrl = embed?.src ?? null;
  const isTikTok = embed?.kind === "tiktok";
  const posterUrl = proxiedThumbnailUrl({ platform, videoUrl, thumbnailUrl });

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const loaded = loadedUrl !== null && loadedUrl === embedUrl;

  // `muted` mirrors the player's actual state (via its onMute event).
  // `soundWanted` is what the user asked for; the two diverge when the
  // browser refuses the unmute, which is how we detect the failure.
  const [muted, setMuted] = useState(true);
  const [soundWanted, setSoundWanted] = useState(readSoundPref);
  const [unmuteBlocked, setUnmuteBlocked] = useState(false);
  const blockedTimer = useRef<number | null>(null);

  // Reset playback state when the reel changes (React's "adjust state during
  // render" pattern — cheaper than an effect, and no cascading render). The
  // session sound preference carries over so the user doesn't have to re-tap
  // sound on every single reel.
  const [renderedUrl, setRenderedUrl] = useState(embedUrl);
  if (renderedUrl !== embedUrl) {
    setRenderedUrl(embedUrl);
    setMuted(true);
    setUnmuteBlocked(false);
    setSoundWanted(readSoundPref());
  }

  const post = useCallback((type: string, value?: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(
      { "x-tiktok-player": true, type, value },
      TIKTOK_ORIGIN
    );
  }, []);

  // Listen for the player's own events. Origin- and source-checked so no other
  // frame on the page can spoof playback state.
  useEffect(() => {
    if (!isTikTok) return;
    function onMessage(event: MessageEvent) {
      if (event.origin !== TIKTOK_ORIGIN) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const raw = event.data;
      let data: Record<string, unknown> | null = null;
      if (typeof raw === "string") {
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }
      } else if (raw && typeof raw === "object") {
        data = raw as Record<string, unknown>;
      }
      if (!data || data["x-tiktok-player"] !== true) return;

      if (data.type === "onPlayerReady") {
        // Re-assert the session sound preference on the fresh player.
        if (readSoundPref()) post("unMute");
        return;
      }
      if (data.type === "onMute") {
        const isMuted = data.value !== false;
        setMuted(isMuted);
        if (!isMuted) setUnmuteBlocked(false);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isTikTok, post, embedUrl]);

  function toggleSound() {
    if (!muted) {
      post("mute");
      setMuted(true);
      setSoundWanted(false);
      setUnmuteBlocked(false);
      writeSoundPref(false);
      return;
    }
    setSoundWanted(true);
    writeSoundPref(true);
    post("unMute");
    post("play");
    // Autoplay policy grants user activation to the frame the tap landed in,
    // and activation does not cross an origin boundary — so a tap out here
    // can be silently ignored by the player. If no onMute:false comes back,
    // surface the one thing that always works: tapping TikTok's own speaker
    // icon, inside the iframe, where the gesture actually counts.
    if (blockedTimer.current) window.clearTimeout(blockedTimer.current);
    blockedTimer.current = window.setTimeout(() => setUnmuteBlocked(true), 900);
  }

  useEffect(
    () => () => {
      if (blockedTimer.current) window.clearTimeout(blockedTimer.current);
    },
    []
  );

  const showBlockedHint = isTikTok && unmuteBlocked && muted && soundWanted;

  return (
    <div className={`relative h-full w-full overflow-hidden bg-black ${className}`}>
      {posterUrl ? (
        // Same-origin /api/media-proxy URL (see proxiedThumbnailUrl) — cdnResize
        // (lib/image/cdn.ts) always returns null for these, so this stays a
        // plain <img> rather than SmartImage/next-image; explicit dimensions
        // still help the browser reserve layout before the poster decodes.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={posterUrl}
          alt={caption ?? ""}
          draggable={false}
          width={405}
          height={720}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}

      {embedUrl ? (
        <>
          <iframe
            key={embedUrl}
            ref={iframeRef}
            src={embedUrl}
            title={caption ?? "Reel"}
            allow="autoplay; encrypted-media; fullscreen"
            allowFullScreen
            onLoad={() => setLoadedUrl(embedUrl)}
            className={`absolute inset-0 h-full w-full border-0 transition-opacity duration-300 ${
              loaded ? "opacity-100" : "opacity-0"
            }`}
          />

          {/* TikTok/Instagram's own embed player sometimes needs a
              same-site cookie consent click before it'll actually play the
              video (it 403s otherwise) — and that consent prompt renders
              inside the iframe, so we can't detect or dismiss it. The Open
              link stays on top as a guaranteed way to actually watch the
              reel, since silent embed playback failure isn't otherwise
              detectable cross-origin. z-20 so it sits above ReelViewer's own
              bottom Like/Skip buttons (z-10) if it's ever positioned nearby. */}
          <div className="absolute right-3 top-3 z-20 flex flex-col items-end gap-2">
            {isTikTok ? (
              <button
                type="button"
                aria-label={muted ? "Turn on sound" : "Mute"}
                aria-pressed={!muted}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSound();
                }}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition-transform active:scale-90"
              >
                <Icon name={muted ? "volume_off" : "volume_up"} size={18} />
              </button>
            ) : null}

            <a
              href={videoUrl ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1.5 text-label-sm font-semibold text-white backdrop-blur-sm"
            >
              <Icon name="open_in_new" size={14} />
              Open
            </a>
          </div>

          {showBlockedHint ? (
            // Top area only: the player's own controls (and its consent
            // sheet) live across the bottom half of the iframe, and this hint
            // points the user at them — covering them would defeat it.
            <p className="pointer-events-none absolute inset-x-8 top-20 z-20 rounded-xl bg-black/70 px-3 py-2 text-center text-[11px] font-medium leading-snug text-white backdrop-blur-sm">
              Your browser blocked sound from outside the player — tap the
              speaker icon on the video itself.
            </p>
          ) : null}
        </>
      ) : videoUrl ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/45 text-white">
          <Icon name="open_in_new" size={28} />
          <a
            href={videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            onPointerDown={(e) => e.stopPropagation()}
            className="rounded-full bg-white/20 px-4 py-2 text-label-md font-semibold backdrop-blur-md"
          >
            Open on {platform ?? "source"}
          </a>
        </div>
      ) : !posterUrl ? (
        <div className="absolute inset-0 flex items-center justify-center text-on-primary/40">
          <Icon name="videocam_off" size={32} />
        </div>
      ) : null}
    </div>
  );
}

export default VideoEmbed;
