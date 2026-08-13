import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { MouseEvent } from "react";
import { SelectionProvider } from "@/hooks/selection-provider";
import { useSelection, useThumbnailActivation } from "@/hooks/use-selection";
import { makePhoto } from "./fixtures";

const photo = makePhoto({ id: "1", filename: "beach.jpg" });
const photoB = makePhoto({ id: "2", filename: "sunset.jpg" });
const photoC = makePhoto({ id: "3", filename: "forest.jpg" });
const photoD = makePhoto({ id: "4", filename: "river.jpg" });

// Bundle the interaction handlers with the live selection so a single
// renderHook exposes everything a test needs.
function useHarness(onOpen: (p: typeof photo) => void) {
  const activation = useThumbnailActivation(onOpen);
  const selection = useSelection();
  return { ...activation, selection };
}

function clickEvent(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    detail: 1,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    ...overrides,
  } as MouseEvent;
}

const selectedIds = (selection: { selected: { id: string }[] }) =>
  selection.selected.map((p) => p.id);

describe("useThumbnailActivation", () => {
  it("selects immediately on a single click", () => {
    const { result } = renderHook(() => useHarness(vi.fn()), {
      wrapper: SelectionProvider,
    });

    act(() => result.current.onClick(clickEvent(), photo));
    // No deferral — the select lands right away.
    expect(result.current.selection.isSelected("1")).toBe(true);
  });

  it("opens without leaving a selection when a double click reverts the lead click", () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useHarness(onOpen), {
      wrapper: SelectionProvider,
    });

    act(() => result.current.onClick(clickEvent(), photo));
    act(() => result.current.onDoubleClick(photo));

    expect(onOpen).toHaveBeenCalledWith(photo);
    expect(result.current.selection.selected).toHaveLength(0);
  });

  it("preserves an existing selection when a double click reverts its lead click", () => {
    const { result } = renderHook(() => useHarness(vi.fn()), {
      wrapper: SelectionProvider,
    });

    // Select A, then double click B to open it. The revert must restore the
    // state as it was before B's lead click — A still selected, B not.
    act(() => result.current.onClick(clickEvent(), photo));
    act(() => result.current.onClick(clickEvent(), photoB));
    act(() => result.current.onDoubleClick(photoB));

    expect(result.current.selection.isSelected("1")).toBe(true);
    expect(result.current.selection.isSelected("2")).toBe(false);
  });

  it("replaces the selection on a plain click of another thumbnail", () => {
    const { result } = renderHook(() => useHarness(vi.fn()), {
      wrapper: SelectionProvider,
    });

    act(() => result.current.onClick(clickEvent(), photo));
    act(() => result.current.onClick(clickEvent(), photoB));

    // Finder-style: without a modifier the second click starts a fresh
    // selection rather than adding to the first.
    expect(selectedIds(result.current.selection)).toEqual(["2"]);
  });

  it("adds and removes photos with Cmd+click", () => {
    const { result } = renderHook(() => useHarness(vi.fn()), {
      wrapper: SelectionProvider,
    });

    act(() => result.current.onClick(clickEvent(), photo));
    act(() => result.current.onClick(clickEvent({ metaKey: true }), photoB));
    expect(selectedIds(result.current.selection)).toEqual(["1", "2"]);

    // Cmd+clicking a selected photo takes it back out.
    act(() => result.current.onClick(clickEvent({ metaKey: true }), photo));
    expect(selectedIds(result.current.selection)).toEqual(["2"]);
  });

  it("adds and removes photos with Ctrl+click", () => {
    const { result } = renderHook(() => useHarness(vi.fn()), {
      wrapper: SelectionProvider,
    });

    act(() => result.current.onClick(clickEvent(), photo));
    act(() => result.current.onClick(clickEvent({ ctrlKey: true }), photoB));

    expect(selectedIds(result.current.selection)).toEqual(["1", "2"]);
  });

  it("takes the range back to the last clicked photo with Shift+click", () => {
    const { result } = renderHook(() => useHarness(vi.fn()), {
      wrapper: SelectionProvider,
    });
    act(() =>
      result.current.selection.setPool([photo, photoB, photoC, photoD])
    );

    act(() => result.current.onClick(clickEvent(), photoB));
    act(() => result.current.onClick(clickEvent({ shiftKey: true }), photoD));
    expect(selectedIds(result.current.selection)).toEqual(["2", "3", "4"]);

    // The anchor stays on B, so a shorter Shift+click shrinks the same block
    // instead of extending from D.
    act(() => result.current.onClick(clickEvent({ shiftKey: true }), photoC));
    expect(selectedIds(result.current.selection)).toEqual(["2", "3"]);
  });

  it("adds the range to the selection with Cmd+Shift+click", () => {
    const { result } = renderHook(() => useHarness(vi.fn()), {
      wrapper: SelectionProvider,
    });
    act(() =>
      result.current.selection.setPool([photo, photoB, photoC, photoD])
    );

    act(() => result.current.onClick(clickEvent(), photo));
    act(() => result.current.onClick(clickEvent({ metaKey: true }), photoC));
    act(() =>
      result.current.onClick(
        clickEvent({ metaKey: true, shiftKey: true }),
        photoD
      )
    );

    // The C→D range joins photo 1 rather than wiping it.
    expect(selectedIds(result.current.selection)).toEqual(["1", "3", "4"]);
  });

  it("selects only the clicked photo when Shift+click has no anchor", () => {
    const { result } = renderHook(() => useHarness(vi.fn()), {
      wrapper: SelectionProvider,
    });
    act(() => result.current.selection.setPool([photo, photoB, photoC]));

    act(() => result.current.onClick(clickEvent({ shiftKey: true }), photoC));

    expect(selectedIds(result.current.selection)).toEqual(["3"]);
  });

  it("ignores the trailing click of a double click", () => {
    const { result } = renderHook(() => useHarness(vi.fn()), {
      wrapper: SelectionProvider,
    });

    act(() => result.current.onClick(clickEvent({ detail: 2 }), photo));

    expect(result.current.selection.selected).toHaveLength(0);
  });
});
