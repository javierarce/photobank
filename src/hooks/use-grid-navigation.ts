import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  directionForKey,
  nextGridIndex,
  type NavRect,
} from "@/lib/grid-navigation";

type Options = {
  /** How many navigable tiles the grid currently has. */
  count: number;
  /** Stable id for the tile at `index`; must match its `data-nav-id`. */
  getId: (index: number) => string | undefined;
  /** The grid container to scope tile lookups (focus, rects) to. */
  containerRef: RefObject<HTMLElement | null>;
  /** While false the grid ignores the keyboard (e.g. a lightbox is open). */
  enabled?: boolean;
  /** Enter opens the tile at `index`. */
  onOpen: (index: number) => void;
  /** `x` toggles selection of the tile at `index`; omit for grids without it. */
  onSelect?: (index: number) => void;
  /** Fires after every arrow/hjkl move, before focus settles — the consumer
   *  uses it to extend a Shift-selection to the newly focused tile. */
  onMove?: (nextIndex: number, opts: { shift: boolean; prevIndex: number }) => void;
};

/** A roving keyboard cursor for a wrapping tile grid. The cursor IS real DOM
 * focus — arrow keys and vim hjkl move focus between the tiles, so the highlight
 * is the tiles' own `:focus-visible` style and is shared with plain Tab
 * navigation. Enter opens, `x` selects, and Shift+move reports the sweep so the
 * caller can grow a range selection. The tiles must render `data-nav-id` (in
 * item order) and be natively focusable. */
export function useGridNavigation({
  count,
  getId,
  containerRef,
  enabled = true,
  onOpen,
  onSelect,
  onMove,
}: Options) {
  // The keydown listener is bound once per enabled change; read the moving
  // parts through a ref so it always sees the latest render's values. Written
  // in an effect (never during render) so it stays a plain out-of-render mirror.
  const stateRef = useRef({ count, getId, onOpen, onSelect, onMove });
  useEffect(() => {
    stateRef.current = { count, getId, onOpen, onSelect, onMove };
  });

  const focusItem = useCallback(
    (index: number) => {
      const id = stateRef.current.getId(index);
      if (id == null) return;
      const el = containerRef.current?.querySelector<HTMLElement>(
        `[data-nav-id="${CSS.escape(id)}"]`
      );
      // preventScroll + explicit scrollIntoView keeps the jump gentle rather
      // than snapping the tile to the viewport edge.
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: "nearest" });
    },
    [containerRef]
  );

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Let other shortcuts (Cmd+A, Cmd+K, …) and the browser keep their combos.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      const { count, getId, onOpen, onSelect, onMove } = stateRef.current;
      if (!count) return;

      // The cursor is whichever of this grid's tiles currently holds focus.
      const active = document.activeElement;
      const inThisGrid = !!active && !!containerRef.current?.contains(active);
      const activeId = inThisGrid ? active.getAttribute("data-nav-id") : null;
      let index = -1;
      if (activeId != null) {
        for (let i = 0; i < count; i++) {
          if (getId(i) === activeId) {
            index = i;
            break;
          }
        }
      }

      if (e.key === "Enter") {
        if (index >= 0) {
          e.preventDefault();
          onOpen(index);
        }
        return;
      }

      if ((e.key === "x" || e.key === "X") && onSelect) {
        if (index >= 0) {
          e.preventDefault();
          onSelect(index);
        }
        return;
      }

      const dir = directionForKey(e.key);
      if (!dir) return;

      // With no tile focused yet, an arrow "enters" the grid — but only from a
      // neutral spot (nothing focused, or focus already inside the grid), so we
      // don't yank focus away from some other control the user is driving.
      if (index < 0) {
        const parked = !active || active === document.body || inThisGrid;
        if (!parked) return;
      }
      e.preventDefault();

      // Measure the tiles fresh each move: layout (and column count) shifts with
      // the window, so a cached grid geometry would misroute up/down. Collect
      // the elements in one querySelectorAll and index them by id — a
      // querySelector per tile would rescan the subtree n times (O(n²)) and lag
      // on a folder of thousands.
      const byId = new Map<string, Element>();
      for (const el of containerRef.current?.querySelectorAll("[data-nav-id]") ??
        []) {
        const id = el.getAttribute("data-nav-id");
        if (id != null) byId.set(id, el);
      }
      const rects: NavRect[] = [];
      for (let i = 0; i < count; i++) {
        const id = getId(i);
        const el = id != null ? byId.get(id) : undefined;
        if (!el) {
          rects.push(null);
          continue;
        }
        const r = el.getBoundingClientRect();
        rects.push({ top: r.top, left: r.left, width: r.width });
      }

      const next = nextGridIndex(dir, index, count, rects);
      onMove?.(next, { shift: e.shiftKey, prevIndex: index });
      focusItem(next);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled, containerRef, focusItem]);
}
