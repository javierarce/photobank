import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Photo } from "@/lib/types";
import {
  SelectionContext,
  type SelectionActions,
} from "@/hooks/use-selection";

/** Holds the multi-select state shared between the grids and the title bar. */
export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Photo[]>([]);
  const [pool, setPool] = useState<Photo[]>([]);
  const [actions, setActions] = useState<SelectionActions | null>(null);
  // The last photo clicked; Shift-click selects the range back to it.
  const anchorRef = useRef<string | null>(null);

  // O(1) membership so a grid of thumbnails checking isSelected on every
  // render stays cheap even with a large selection.
  const selectedIds = useMemo(
    () => new Set(selected.map((p) => p.id)),
    [selected]
  );
  const isSelected = useCallback(
    (id: string) => selectedIds.has(id),
    [selectedIds]
  );

  const toggle = useCallback((photo: Photo) => {
    setSelected((prev) =>
      prev.some((p) => p.id === photo.id)
        ? prev.filter((p) => p.id !== photo.id)
        : [...prev, photo]
    );
    anchorRef.current = photo.id;
  }, []);

  // A modifier-less click, Finder-style: this photo becomes the whole selection
  // and the anchor a following Shift-click ranges from.
  const selectOnly = useCallback((photo: Photo) => {
    setSelected([photo]);
    anchorRef.current = photo.id;
  }, []);

  const selectRange = useCallback(
    (photo: Photo, { additive = false }: { additive?: boolean } = {}) => {
      const anchorId = anchorRef.current;
      const anchorIdx = anchorId
        ? pool.findIndex((p) => p.id === anchorId)
        : -1;
      const targetIdx = pool.findIndex((p) => p.id === photo.id);
      if (anchorIdx === -1 || targetIdx === -1) {
        // No usable anchor (or an unknown photo) — fall back to what the same
        // click without Shift would have done, which also seeds the anchor.
        setSelected((prev) =>
          additive
            ? prev.some((p) => p.id === photo.id)
              ? prev
              : [...prev, photo]
            : [photo]
        );
        anchorRef.current = photo.id;
        return;
      }
      const [start, end] =
        anchorIdx < targetIdx
          ? [anchorIdx, targetIdx]
          : [targetIdx, anchorIdx];
      const span = pool.slice(start, end + 1);
      setSelected((prev) => {
        // Plain Shift-click *is* the selection (so re-clicking closer to the
        // anchor shrinks it); Cmd+Shift-click unions the span into what's
        // already there, keeping the existing order.
        if (!additive) return span;
        const byId = new Map(prev.map((p) => [p.id, p]));
        for (const p of span) byId.set(p.id, p);
        return Array.from(byId.values());
      });
      // Anchor intentionally left put, so successive Shift-clicks re-range from
      // the same origin instead of walking it forward one tile at a time.
    },
    [pool]
  );

  // Capture the current selection + anchor; the returned fn restores both.
  // Read `selected` through a ref so snapshot keeps a STABLE identity across
  // selection changes — that stability lets the memoized grid tiles skip
  // re-rendering when only their neighbours' selected state changed.
  // Kept current via an effect (not written during render) so snapshot, called
  // only from click handlers after commit, always sees the latest selection.
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const snapshot = useCallback(() => {
    const prevSelected = selectedRef.current;
    const prevAnchor = anchorRef.current;
    return () => {
      setSelected(prevSelected);
      anchorRef.current = prevAnchor;
    };
  }, []);

  // Shift+arrow keyboard range. Unlike selectRange (which unions and moves the
  // anchor to the target), this replaces the selection with the whole
  // anchor→target span and leaves the anchor put, so repeated Shift+moves grow
  // AND shrink one contiguous block. The first step seeds the anchor at the
  // cursor's origin so that tile is included too.
  const extendTo = useCallback(
    (target: Photo, origin: Photo) => {
      let anchorId = anchorRef.current;
      if (anchorId == null || !pool.some((p) => p.id === anchorId)) {
        anchorId = origin.id;
        anchorRef.current = origin.id;
      }
      const anchorIdx = pool.findIndex((p) => p.id === anchorId);
      const targetIdx = pool.findIndex((p) => p.id === target.id);
      if (anchorIdx === -1 || targetIdx === -1) return;
      const [start, end] =
        anchorIdx < targetIdx
          ? [anchorIdx, targetIdx]
          : [targetIdx, anchorIdx];
      setSelected(pool.slice(start, end + 1));
      // Anchor intentionally left at anchorId so the next step extends from the
      // same origin.
    },
    [pool]
  );

  const selectAll = useCallback((photos: Photo[]) => setSelected(photos), []);

  const clear = useCallback(() => {
    setSelected([]);
    anchorRef.current = null;
  }, []);

  // Drop any selected photo that is no longer among `ids`. The grids call this
  // when a filter hides tiles, so the selection can never outlive what's on
  // screen — otherwise the toolbar would report a count the user can't see and
  // a bulk delete would destroy hidden photos. Returns the previous array
  // unchanged when nothing was dropped, so callers can run it from an effect
  // without looping.
  const retain = useCallback((ids: Set<string>) => {
    setSelected((prev) => {
      const next = prev.filter((p) => ids.has(p.id));
      return next.length === prev.length ? prev : next;
    });
    if (anchorRef.current && !ids.has(anchorRef.current)) anchorRef.current = null;
  }, []);

  const value = useMemo(
    () => ({
      selected,
      isSelected,
      toggle,
      selectOnly,
      selectRange,
      extendTo,
      snapshot,
      selectAll,
      clear,
      retain,
      pool,
      setPool,
      actions,
      setActions,
    }),
    [
      selected,
      isSelected,
      toggle,
      selectOnly,
      selectRange,
      extendTo,
      snapshot,
      selectAll,
      clear,
      retain,
      pool,
      actions,
    ]
  );

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  );
}
