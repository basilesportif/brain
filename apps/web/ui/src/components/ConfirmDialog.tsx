import { useEffect, useRef, type ReactNode } from "react";

// Standard confirm dialog (plan §5.3): replaces the old approval-phrase ritual.
// Used before secret overwrites and settings writes. Secret values are never
// displayed here — only the affected keys and impact.
//
// SAFETY (finding 8): while `busy` (committing), the backdrop click and Escape
// are inert — a commit in flight must not be dismissed out from under itself, and
// a commit error keeps the dialog open (the caller closes only on success). The
// confirm button can also be independently disabled via `confirmDisabled` (e.g.
// no successful impact preview loaded yet) without the "Working…" busy label.

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  confirmLabel?: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}

export function ConfirmDialog({ open, title, confirmLabel = "Confirm", busy = false, confirmDisabled = false, onConfirm, onCancel, children }: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      // Never dismiss a commit in flight (finding 8).
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  // Backdrop click dismisses only when idle; a commit in flight is undismissable.
  const onBackdrop = () => {
    if (!busy) onCancel();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onBackdrop}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>
        <div>{children}</div>
        <div className="modal-actions">
          <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" type="button" ref={confirmRef} onClick={onConfirm} disabled={busy || confirmDisabled}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
