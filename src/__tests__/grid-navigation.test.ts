import { describe, it, expect } from "vitest";
import {
  nextGridIndex,
  directionForKey,
  type NavRect,
} from "@/lib/grid-navigation";

// A 3-column grid of 8 tiles, laid out row by row. Rows are 100px tall, tiles
// 100px wide with a 10px gutter.
//   0 1 2
//   3 4 5
//   6 7
function grid(cols: number, count: number, size = 100, gap = 10): NavRect[] {
  return Array.from({ length: count }, (_, i) => ({
    top: Math.floor(i / cols) * (size + gap),
    left: (i % cols) * (size + gap),
    width: size,
  }));
}

describe("nextGridIndex", () => {
  const rects = grid(3, 8);

  it("moves left and right, clamping at the row-agnostic ends", () => {
    expect(nextGridIndex("right", 0, 8, rects)).toBe(1);
    expect(nextGridIndex("left", 1, 8, rects)).toBe(0);
    // Left from the very first tile stays put.
    expect(nextGridIndex("left", 0, 8, rects)).toBe(0);
    // Right from the very last tile stays put.
    expect(nextGridIndex("right", 7, 8, rects)).toBe(7);
  });

  it("moves down to the tile in the row below nearest the same column", () => {
    expect(nextGridIndex("down", 1, 8, rects)).toBe(4);
    expect(nextGridIndex("down", 4, 8, rects)).toBe(7);
  });

  it("moves up to the tile in the row above nearest the same column", () => {
    expect(nextGridIndex("up", 4, 8, rects)).toBe(1);
    expect(nextGridIndex("up", 7, 8, rects)).toBe(4);
  });

  it("stays put moving up from the top row or down from the last row", () => {
    expect(nextGridIndex("up", 2, 8, rects)).toBe(2);
    // Tile 6 is alone on the last row; nothing below it.
    expect(nextGridIndex("down", 6, 8, rects)).toBe(6);
  });

  it("lands on the nearest column when the row below is ragged", () => {
    // Down from tile 5 (column 2, last full row) → the last row has only 6 and
    // 7 (columns 0 and 1); column 1 is nearest column 2.
    expect(nextGridIndex("down", 5, 8, rects)).toBe(7);
  });

  it("focuses an end of the grid on the first move with nothing focused", () => {
    expect(nextGridIndex("right", -1, 8, rects)).toBe(0);
    expect(nextGridIndex("down", -1, 8, rects)).toBe(0);
    expect(nextGridIndex("last", -1, 8, rects)).toBe(7);
  });

  it("jumps to the first and last tile with Home/End", () => {
    expect(nextGridIndex("first", 5, 8, rects)).toBe(0);
    expect(nextGridIndex("last", 2, 8, rects)).toBe(7);
  });

  it("returns -1 for an empty grid", () => {
    expect(nextGridIndex("right", -1, 0, [])).toBe(-1);
  });

  it("does not move vertically when the current tile can't be measured", () => {
    const unmeasured: NavRect[] = [null, null, null];
    expect(nextGridIndex("down", 1, 3, unmeasured)).toBe(1);
  });
});

describe("directionForKey", () => {
  it("maps the arrow keys", () => {
    expect(directionForKey("ArrowLeft")).toBe("left");
    expect(directionForKey("ArrowRight")).toBe("right");
    expect(directionForKey("ArrowUp")).toBe("up");
    expect(directionForKey("ArrowDown")).toBe("down");
  });

  it("maps vim hjkl, including the Shift-held capitals", () => {
    expect(directionForKey("h")).toBe("left");
    expect(directionForKey("l")).toBe("right");
    expect(directionForKey("k")).toBe("up");
    expect(directionForKey("j")).toBe("down");
    expect(directionForKey("H")).toBe("left");
    expect(directionForKey("L")).toBe("right");
    expect(directionForKey("K")).toBe("up");
    expect(directionForKey("J")).toBe("down");
  });

  it("maps Home/End and ignores unrelated keys", () => {
    expect(directionForKey("Home")).toBe("first");
    expect(directionForKey("End")).toBe("last");
    expect(directionForKey("a")).toBeNull();
    expect(directionForKey("Enter")).toBeNull();
    expect(directionForKey("x")).toBeNull();
  });
});
