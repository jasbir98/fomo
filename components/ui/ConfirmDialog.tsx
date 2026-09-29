"use client";

import { BottomSheet } from "./BottomSheet";
import { Button } from "./Button";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button + error styling for destructive actions (e.g. delete). */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Confirmation prompt built on BottomSheet — used before irreversible actions
 * (e.g. deleting a trip) so a stray tap can't destroy data silently.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <BottomSheet open={open} onClose={onCancel} title={title}>
      <div className="flex flex-col gap-4">
        {description ? (
          <p className="text-body-md text-on-surface-variant">{description}</p>
        ) : null}
        <div className="flex gap-3">
          <Button variant="outline" fullWidth onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger" : "navy"} fullWidth onClick={onConfirm} disabled={busy}>
            {busy ? "Deleting…" : confirmLabel}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

export default ConfirmDialog;
