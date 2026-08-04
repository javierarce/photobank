// Keyboard navigation math for the folder and photo grids. Kept pure (no DOM,
// no React) so the 2D wrap-around logic can be unit-tested with synthetic
// rects — jsdom returns all-zero getBoundingClientRect, so vertical movement
// can only be exercised here, not through a rendered grid.

/** A tile's on-screen box, or null when it couldn't be measured. */
export type NavRect = { top: number; left: number; width: number } | null;

export type NavDirection = "left" | "right" | "up" | "down" | "first" | "last";

// Rows in a wrapping grid share a `top`; allow a few px of slack so subpixel
// layout differences don't split one visual row into two.
const ROW_TOLERANCE = 4;

/** Move up or down a wrapping grid by geometry: jump to the nearest tile in the
 * adjacent row, matched by horizontal centre. Falls back to no move when the
 * current tile can't be measured or there is no row in that direction. */
function moveVertical(
  rects: NavRect[],
  index: number,
  dir: "up" | "down"
): number {
  const cur = rects[index];
  if (!cur) return index;
  const curCentre = cur.left + cur.width / 2;

  // The target row is the closest distinct `top` beyond the current one in the
  // travel direction.
  let targetTop: number | null = null;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (!r) continue;
    const beyond =
      dir === "down"
        ? r.top > cur.top + ROW_TOLERANCE
        : r.top < cur.top - ROW_TOLERANCE;
    if (!beyond) continue;
    if (
      targetTop === null ||
      (dir === "down" ? r.top < targetTop : r.top > targetTop)
    ) {
      targetTop = r.top;
    }
  }
  if (targetTop === null) return index;

  // Within that row, land on the tile whose centre is nearest the current one.
  let best = index;
  let bestDx = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (!r || Math.abs(r.top - targetTop) > ROW_TOLERANCE) continue;
    const dx = Math.abs(r.left + r.width / 2 - curCentre);
    if (dx < bestDx) {
      bestDx = dx;
      best = i;
    }
  }
  return best;
}

/** Compute the index the cursor should move to. `index` is the current focus
 * (-1 when nothing is focused yet); `rects` are the tile boxes in item order,
 * used only for up/down. Horizontal moves clamp at the ends rather than wrap,
 * matching how the arrows feel in a Finder-style grid. */
export function nextGridIndex(
  dir: NavDirection,
  index: number,
  count: number,
  rects: NavRect[]
): number {
  if (count <= 0) return -1;
  // First key press with nothing focused lands on an end of the grid.
  if (index < 0 || index >= count) {
    return dir === "last" ? count - 1 : 0;
  }
  switch (dir) {
    case "left":
      return Math.max(0, index - 1);
    case "right":
      return Math.min(count - 1, index + 1);
    case "first":
      return 0;
    case "last":
      return count - 1;
    case "up":
      return moveVertical(rects, index, "up");
    case "down":
      return moveVertical(rects, index, "down");
  }
}

/** Map a keydown to a grid direction, covering both the arrow keys and vim's
 * hjkl (case-insensitive, so a Shift-held capital still navigates). Returns
 * null for keys the grid doesn't drive. */
export function directionForKey(key: string): NavDirection | null {
  switch (key) {
    case "ArrowLeft":
    case "h":
    case "H":
      return "left";
    case "ArrowRight":
    case "l":
    case "L":
      return "right";
    case "ArrowUp":
    case "k":
    case "K":
      return "up";
    case "ArrowDown":
    case "j":
    case "J":
      return "down";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
}
