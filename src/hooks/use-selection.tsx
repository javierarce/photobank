import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import type { Photo } from "@/lib/types";

/** Bulk actions the visible grid exposes to the header's selection toolbar. */
export type SelectionActions = {
  onDelete: (photos: Photo[]) => void | Promise<void>;
  onMove: (photos: Photo[]) => void | Promise<void>;
  onTag: (photos: Photo[]) => void | Promise<void>;
};

export type SelectionContextValue = {
  /** The currently selected photos, in the order they were tapped. */
  selected: Photo[];
  isSelected: (id: string) => boolean;
  toggle: (photo: Photo) => void;
  /** Make this photo the entire selection (a modifier-less click). */
  selectOnly: (photo: Photo) => void;
  /** Select the anchor→photo range (Shift-click). Replaces the selection with
   * that span, or unions it in when `additive` (Cmd+Shift-click); the anchor
   * stays put so the next Shift-click re-ranges from the same origin. */
  selectRange: (photo: Photo, opts?: { additive?: boolean }) => void;
  /** Keyboard Shift+move range: replace the selection with the contiguous span
   * from the anchor to `target`, seeding the anchor at `origin` on the first
   * step and keeping it fixed after, so the span can grow and shrink. */
  extendTo: (target: Photo, origin: Photo) => void;
  /** Snapshot the current selection + anchor, returning a restore fn. Used to
   * undo the leading click of a double click so opening never alters state. */
  snapshot: () => () => void;
  /** Replace the selection with exactly these photos (used by Cmd+A). */
  selectAll: (photos: Photo[]) => void;
  clear: () => void;
  /** Drop any selected photo whose id isn't in `ids` — keeps the selection
   * confined to the tiles a filter is actually showing, so bulk actions can
   * never reach a photo the user can't see. */
  retain: (ids: Set<string>) => void;
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
 * Thumbnail interaction, following the OS file manager: a plain click selects
 * just that photo, Cmd/Ctrl+click toggles one in or out of the selection,
 * Shift+click takes the range back to the last clicked photo (Cmd+Shift+click
 * adds that range), and a double click opens. The select commits on the first
 * click for an instant, weightless feel; if that click turns out to be the lead
 * of a double click, the dblclick handler reverts it so opening never alters
 * the selection or anchor. The brief flash before the revert is hidden behind
 * the opening lightbox.
 */
export function useThumbnailActivation(onOpen: (photo: Photo) => void) {
  const { toggle, selectOnly, selectRange, snapshot } = useSelection();
  // How to undo the most recent click's select, kept so a double click that
  // lands right after can roll it back. One hook instance is shared by every
  // thumbnail; only a dblclick on the same tile consumes this.
  const undo = useRef<(() => void) | null>(null);

  const onClick = useCallback(
    (e: MouseEvent, photo: Photo) => {
      // Ignore the trailing click of a double click; the dblclick handler owns
      // it and the leading click already ran.
      if (e.detail > 1) return;
      const restore = snapshot();
      const additive = e.metaKey || e.ctrlKey;
      if (e.shiftKey) selectRange(photo, { additive });
      else if (additive) toggle(photo);
      else selectOnly(photo);
      undo.current = restore;
    },
    [toggle, selectOnly, selectRange, snapshot]
  );

  const onDoubleClick = useCallback(
    (photo: Photo) => {
      // Roll back the leading click's select so opening never touches state.
      undo.current?.();
      undo.current = null;
      onOpen(photo);
    },
    [onOpen]
  );

  return { onClick, onDoubleClick };
}

/** An open thumbnail context menu: what it acts on, and where it opened. */
export type ContextMenuTarget = {
  photos: Photo[];
  /** Viewport coordinates of the click that opened it. */
  x: number;
  y: number;
};

/**
 * Right-click on a thumbnail, following the OS file manager: right-clicking a
 * photo that's already in the selection keeps the selection and acts on all of
 * it; right-clicking anywhere else makes that photo the selection first, so the
 * menu's target is always what's highlighted.
 */
export function useThumbnailContextMenu() {
  const { selected, selectOnly } = useSelection();
  const [menu, setMenu] = useState<ContextMenuTarget | null>(null);

  // Read the selection through a ref (same reason as `snapshot` in
  // selection-provider): it keeps onContextMenu's identity stable, so the
  // memoized tiles don't all re-render whenever the selection changes.
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const onContextMenu = useCallback(
    (e: MouseEvent, photo: Photo) => {
      // Suppress WKWebView's own menu ("Save Image As…", "Reload") and keep the
      // click off the page's background-deselect handler.
      e.preventDefault();
      e.stopPropagation();
      const inSelection = selectedRef.current.some((p) => p.id === photo.id);
      if (!inSelection) selectOnly(photo);
      setMenu({
        photos: inSelection ? selectedRef.current : [photo],
        x: e.clientX,
        y: e.clientY,
      });
    },
    [selectOnly]
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  return { menu, onContextMenu, closeMenu };
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
