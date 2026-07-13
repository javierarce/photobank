import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type MouseEvent,
} from "react";
import type { Photo } from "@/lib/types";

/** Bulk actions the visible grid exposes to the header's selection toolbar. */
export type SelectionActions = {
  onDelete: (photos: Photo[]) => void | Promise<void>;
  onMove: (photos: Photo[]) => void | Promise<void>;
};

export type SelectionContextValue = {
  /** The currently selected photos, in the order they were tapped. */
  selected: Photo[];
  isSelected: (id: string) => boolean;
  toggle: (photo: Photo) => void;
  /** Extend the selection from the anchor to this photo (Shift-click range). */
  selectRange: (photo: Photo) => void;
  /** Replace the selection with exactly these photos (used by Cmd+A). */
  selectAll: (photos: Photo[]) => void;
  clear: () => void;
  /** The selectable photos published by the visible grid (for "Select all"). */
  pool: Photo[];
  setPool: (photos: Photo[]) => void;
  /** Bulk handlers registered by the grid that owns the visible photos. */
  actions: SelectionActions | null;
  setActions: (actions: SelectionActions | null) => void;
};

export const SelectionContext = createContext<SelectionContextValue | null>(
  null
);

export function useSelection() {
  const ctx = useContext(SelectionContext);
  if (!ctx) {
    throw new Error("useSelection must be used within a SelectionProvider");
  }
  return ctx;
}

/** How long to wait for a second click before treating a click as a select.
 * Matches a typical OS double-click threshold. */
const DOUBLE_CLICK_MS = 250;

/**
 * Thumbnail interaction: a single click selects (toggles), a double click
 * opens. The select is deferred by one double-click window so a double click
 * can cancel it — otherwise the first click of a double click would flash the
 * thumb selected before the photo opens, and leave the anchor moved.
 */
export function useThumbnailActivation(onOpen: (photo: Photo) => void) {
  const { toggle, selectRange } = useSelection();
  // A single pending select, holding the timer plus the select to run so it can
  // be committed early. One hook instance is shared by every thumbnail, so the
  // pending select may belong to a different photo than the one now clicked.
  const pending = useRef<{
    timer: ReturnType<typeof setTimeout>;
    run: () => void;
  } | null>(null);

  const cancelPending = useCallback(() => {
    if (pending.current !== null) {
      clearTimeout(pending.current.timer);
      pending.current = null;
    }
  }, []);

  const flushPending = useCallback(() => {
    const p = pending.current;
    if (p !== null) {
      clearTimeout(p.timer);
      pending.current = null;
      p.run();
    }
  }, []);

  const onClick = useCallback(
    (e: MouseEvent, photo: Photo) => {
      // Ignore the trailing click of a double click; the dblclick handler owns
      // it. Reading shiftKey up front keeps it available inside the timer.
      if (e.detail > 1) return;
      const range = e.shiftKey;
      // A fresh click means any pending select was a genuine single click (a
      // double click lands on the same photo and fires dblclick, not a second
      // onClick). Commit it now so rapid clicks across thumbnails all register.
      flushPending();
      const run = () => (range ? selectRange(photo) : toggle(photo));
      const timer = setTimeout(() => {
        pending.current = null;
        run();
      }, DOUBLE_CLICK_MS);
      pending.current = { timer, run };
    },
    [toggle, selectRange, flushPending]
  );

  const onDoubleClick = useCallback(
    (photo: Photo) => {
      // Drop the pending select so opening never touches the selection.
      cancelPending();
      onOpen(photo);
    },
    [onOpen, cancelPending]
  );

  useEffect(() => cancelPending, [cancelPending]);

  return { onClick, onDoubleClick };
}

/**
 * An onClick handler for a page container: clicking empty canvas clears the
 * selection, while clicks on a thumbnail, the toolbar, or any control are
 * left alone.
 */
export function useBackgroundDeselect() {
  const { selected, clear } = useSelection();
  return useCallback(
    (e: MouseEvent) => {
      if (!selected.length) return;
      const el = e.target as HTMLElement;
      if (
        el.closest(
          "button, a, input, select, textarea, label, [data-selection-toolbar]"
        )
      ) {
        return;
      }
      clear();
    },
    [selected.length, clear]
  );
}
