import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useThumbnailActivation", () => {
  it("selects on a single click once the double-click window passes", () => {
    const { result } = renderHook(() => useHarness(vi.fn()), {
      wrapper: SelectionProvider,
    });

    act(() => result.current.onClick(clickEvent(), photo));
    // Nothing selected yet — the select is deferred.
    expect(result.current.selection.selected).toHaveLength(0);

    act(() => vi.advanceTimersByTime(250));
    expect(result.current.selection.isSelected("1")).toBe(true);
  });

  it("opens without selecting when a double click cancels the pending select", () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useHarness(onOpen), {
      wrapper: SelectionProvider,
    });

    act(() => result.current.onClick(clickEvent(), photo));
    act(() => result.current.onDoubleClick(photo));
    act(() => vi.advanceTimersByTime(250));

    expect(onOpen).toHaveBeenCalledWith(photo);
    expect(result.current.selection.selected).toHaveLength(0);
  });

  it("commits a pending select when a different thumbnail is clicked", () => {
    const photoB = makePhoto({ id: "2", filename: "sunset.jpg" });
    const { result } = renderHook(() => useHarness(vi.fn()), {
      wrapper: SelectionProvider,
    });

    // Click A, then click B within the double-click window. A's deferred select
    // must still land — clicking B should not swallow it.
    act(() => result.current.onClick(clickEvent(), photo));
    act(() => result.current.onClick(clickEvent(), photoB));
    expect(result.current.selection.isSelected("1")).toBe(true);

    act(() => vi.advanceTimersByTime(250));
    expect(result.current.selection.isSelected("1")).toBe(true);
    expect(result.current.selection.isSelected("2")).toBe(true);
  });

  it("ignores the trailing click of a double click", () => {
    const { result } = renderHook(() => useHarness(vi.fn()), {
      wrapper: SelectionProvider,
    });

    act(() => result.current.onClick(clickEvent({ detail: 2 }), photo));
    act(() => vi.advanceTimersByTime(250));

    expect(result.current.selection.selected).toHaveLength(0);
  });
});
