import { useEffect, type ReactNode } from "react";

interface ModalFooter {
  confirmLabel: string;
  /** Label shown on the confirm button while busy. Defaults to confirmLabel. */
  busyLabel?: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
}

interface ModalDialogProps {
  title: ReactNode;
  children: ReactNode;
  /** Blocks the backdrop/Escape close and disables the footer while true. */
  busy?: boolean;
  onClose: () => void;
  footer?: ModalFooter;
}

/**
 * A centered modal matching the lightbox's chrome (same backdrop/animation),
 * with a title, arbitrary body, and an optional Cancel/confirm footer. Escape
 * and a backdrop click close it (unless busy). The webview has no working
 * window.confirm/prompt, so in-app dialogs like this stand in for them.
 */
export function ModalDialog({
  title,
  children,
  busy = false,
  onClose,
  footer,
}: ModalDialogProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, busy]);

  return (
    <div
      className="backdrop-in fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
      onClick={(e) => {
        // Don't let the backdrop click bubble to the page's deselect handler.
        e.stopPropagation();
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        // No clipping overflow on the card or body: the tag field's
        // autocomplete is absolutely positioned and would otherwise be cut off.
        // Long content (e.g. the in-use tag checklist) scrolls in its own
        // capped, self-clipping container instead.
        className="modal-in relative flex max-h-[85vh] w-[min(95vw,440px)] flex-col rounded-lg border-0 bg-background p-5 dark:border dark:border-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-base font-semibold text-foreground">{title}</h2>
        <div className="min-h-0 flex-1">{children}</div>
        {footer && (
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-foreground/5 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={footer.onConfirm}
              disabled={busy || footer.confirmDisabled}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
            >
              {busy ? footer.busyLabel ?? footer.confirmLabel : footer.confirmLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
