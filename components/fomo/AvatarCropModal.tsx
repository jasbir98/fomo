"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Cropper, { type Area, type Point } from "react-easy-crop";
import { Button, Icon } from "@/components/ui";

const OUTPUT_SIZE = 512;

const noopSubscribe = () => () => {};
/** SSR-safe "are we on the client, past hydration" check without a setState-in-effect. */
function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

export type AvatarCropModalProps = {
  /** Object URL (or data URL) of the just-selected file to crop. */
  imageSrc: string;
  /** Original filename — used to derive the cropped file's extension. */
  fileName: string;
  onCancel: () => void;
  onConfirm: (file: File) => void;
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read that image."));
    img.src = src;
  });
}

/** Draws the cropped region of `imageSrc` into a 512x512 canvas and exports a JPEG Blob. */
async function cropToBlob(imageSrc: string, cropPixels: Area): Promise<Blob> {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas isn't supported in this browser.");

  ctx.drawImage(
    image,
    cropPixels.x,
    cropPixels.y,
    cropPixels.width,
    cropPixels.height,
    0,
    0,
    OUTPUT_SIZE,
    OUTPUT_SIZE
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Couldn't process that image."));
      },
      "image/jpeg",
      0.9
    );
  });
}

/**
 * Full-screen crop step shown after picking an avatar file and before
 * uploading it. Lets the user drag/zoom a circular crop area, then exports
 * the result as a 512x512 JPEG Blob via canvas.
 */
export function AvatarCropModal({ imageSrc, fileName, onCancel, onConfirm }: AvatarCropModalProps) {
  const mounted = useMounted();
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCropComplete = useCallback((_croppedArea: Area, croppedAreaPixelsArg: Area) => {
    setCroppedAreaPixels(croppedAreaPixelsArg);
  }, []);

  async function handleConfirm() {
    if (!croppedAreaPixels || processing) return;
    setProcessing(true);
    setError(null);
    try {
      const blob = await cropToBlob(imageSrc, croppedAreaPixels);
      const file = new File([blob], deriveFileName(fileName), { type: "image/jpeg" });
      onConfirm(file);
    } catch (err) {
      console.error("[avatar-crop] crop failed", err);
      setError(err instanceof Error ? err.message : "Couldn't crop that image — try again.");
      setProcessing(false);
    }
  }

  if (!mounted) return null;

  // Portals to document.body for the same reason BottomSheet does: `fixed`
  // positioning is scoped to the nearest ancestor with a
  // transform/filter/backdrop-filter (a CSS containing-block rule). Several
  // of this app's sticky headers use backdrop-blur, so without a portal
  // this modal would render beneath the app's fixed bottom nav (z-50)
  // instead of covering the full viewport above it.
  return createPortal(
    // z-index set inline (not via a Tailwind arbitrary-value class) so it
    // doesn't depend on this exact value having been scanned/compiled into
    // the CSS bundle already — it just needs to beat BottomNav's z-50 and
    // BottomSheet's z-60.
    <div className="fixed inset-0 flex flex-col bg-black" style={{ zIndex: 70 }}>
      <div className="relative flex-1">
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          aspect={1}
          cropShape="round"
          showGrid={false}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onCropComplete}
        />
      </div>
      <div className="flex flex-col gap-4 bg-surface-container-lowest p-5 pb-safe">
        <div className="flex items-center gap-3">
          <Icon name="zoom_out" size={20} className="text-on-surface-variant" />
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            aria-label="Zoom"
            className="h-1.5 w-full appearance-none rounded-full bg-outline-variant accent-primary"
          />
          <Icon name="zoom_in" size={20} className="text-on-surface-variant" />
        </div>
        {error ? <p className="text-label-sm text-error">{error}</p> : null}
        <div className="flex gap-3">
          <Button variant="ghost" fullWidth onClick={onCancel} disabled={processing}>
            Cancel
          </Button>
          <Button
            variant="navy"
            fullWidth
            onClick={() => void handleConfirm()}
            disabled={processing || !croppedAreaPixels}
          >
            {processing ? "Processing…" : "Use photo"}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function deriveFileName(originalName: string): string {
  const base = originalName.replace(/\.[^./\\]+$/, "") || "avatar";
  return `${base}-cropped.jpg`;
}

export default AvatarCropModal;
