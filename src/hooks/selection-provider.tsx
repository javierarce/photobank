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

  const selectRange = useCallback(
    (photo: Photo) => {
      const anchorId = anchorRef.current;
      const anchorIdx = anchorId
        ? pool.findIndex((p) => p.id === anchorId)
        : -1;
      const targetIdx = pool.findIndex((p) => p.id === photo.id);
      if (anchorIdx === -1 || targetIdx === -1) {
        // No usable anchor (or an unknown photo) — behave like a plain add.
        setSelected((prev) =>
          prev.some((p) => p.id === photo.id) ? prev : [...prev, photo]
        );
        anchorRef.current = photo.id;
        return;
      }
      const [start, end] =
        anchorIdx < targetIdx
          ? [anchorIdx, targetIdx]
          : [targetIdx, anchorIdx];
      setSelected((prev) => {
        // Keep the existing order, union in the whole anchor→target span.
        const byId = new Map(prev.map((p) => [p.id, p]));
        for (let i = start; i <= end; i++) byId.set(pool[i].id, pool[i]);
        return Array.from(byId.values());
      });
      anchorRef.current = photo.id;
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

  const selectAll = useCallback((photos: Photo[]) => setSelected(photos), []);

  const clear = useCallback(() => {
    setSelected([]);
    anchorRef.current = null;
  }, []);

  const value = useMemo(
    () => ({
      selected,
      isSelected,
      toggle,
      selectRange,
      snapshot,
      selectAll,
      clear,
      pool,
      setPool,
      actions,
      setActions,
    }),
    [
      selected,
      isSelected,
      toggle,
      selectRange,
      snapshot,
      selectAll,
      clear,
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
