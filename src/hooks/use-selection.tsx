import {
  createContext,
  useCallback,
  useContext,
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

/**
 * Thumbnail interaction: a single click selects (toggles) instantly, a double
 * click opens. Selecting happens immediately for a snappy feel; the second
 * click of a double click (detail > 1) is ignored so it doesn't undo the
 * first, and the dblclick handler opens the photo.
 */
export function useThumbnailActivation(onOpen: (photo: Photo) => void) {
  const { toggle, selectRange } = useSelection();

  const onClick = useCallback(
    (e: MouseEvent, photo: Photo) => {
      if (e.detail > 1) return;
      if (e.shiftKey) selectRange(photo);
      else toggle(photo);
    },
    [toggle, selectRange]
  );

  const onDoubleClick = useCallback(
    (photo: Photo) => {
      // The first click of this double click already toggled the photo; undo
      // it so opening doesn't change the selection. (The lightbox covers the
      // grid, so the momentary flip isn't visible.)
      toggle(photo);
      onOpen(photo);
    },
    [toggle, onOpen]
  );

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
