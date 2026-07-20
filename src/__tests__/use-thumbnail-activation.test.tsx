import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { MouseEvent } from "react";
import { SelectionProvider } from "@/hooks/selection-provider";
import { useSelection, useThumbnailActivation } from "@/hooks/use-selection";
import { makePhoto } from "./fixtures";

const photo = makePhoto({ id: "1", filename: "beach.jpg" });

// Bundle the interaction handlers with the live selection so a single
// renderHook exposes everything a test needs.
function useHarness(onOpen: (p: typeof photo) => void) {
  const activation = useThumbnailActivation(onOpen);
  const selection = useSelection();
  return { ...activation, selection };
}

function clickEvent(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return { detail: 1, shiftKey: false, ...overrides } as MouseEvent;
}

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
    const photoB = makePhoto({ id: "2", filename: "sunset.jpg" });
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

  it("keeps selections from clicks on different thumbnails", () => {
    const photoB = makePhoto({ id: "2", filename: "sunset.jpg" });
    const { result } = renderHook(() => useHarness(vi.fn()), {
      wrapper: SelectionProvider,
    });

    act(() => result.current.onClick(clickEvent(), photo));
    act(() => result.current.onClick(clickEvent(), photoB));

    expect(result.current.selection.isSelected("1")).toBe(true);
    expect(result.current.selection.isSelected("2")).toBe(true);
  });

  it("ignores the trailing click of a double click", () => {
    const { result } = renderHook(() => useHarness(vi.fn()), {
      wrapper: SelectionProvider,
    });

    act(() => result.current.onClick(clickEvent({ detail: 2 }), photo));

    expect(result.current.selection.selected).toHaveLength(0);
  });
});
