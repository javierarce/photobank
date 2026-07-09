import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useUpload } from "@/hooks/use-upload";

afterEach(() => {
  cleanup();
});

// A tiny harness that surfaces the hook's state through the DOM so we can
// exercise the drag handlers the folder page spreads over its whole area.
function Harness({ folder }: { folder?: string }) {
  const { isDragging, dragHandlers, openFilePicker } = useUpload({ folder });

  return (
    <div>
      <div data-testid="drop-area" {...dragHandlers}>
        {isDragging ? "dragging" : "idle"}
      </div>
      <button onClick={openFilePicker}>Upload</button>
    </div>
  );
}

describe("useUpload", () => {
  it("flags dragging on drag enter", () => {
    render(<Harness />);
    const area = screen.getByTestId("drop-area");

    expect(area).toHaveTextContent("idle");
    fireEvent.dragEnter(area);
    expect(area).toHaveTextContent("dragging");
  });

  it("clears dragging when the drag leaves the area", () => {
    render(<Harness />);
    const area = screen.getByTestId("drop-area");

    fireEvent.dragEnter(area);
    fireEvent.dragLeave(area);
    expect(area).toHaveTextContent("idle");
  });

  it("stays dragging while moving across nested children (enter/leave balance)", () => {
    render(<Harness />);
    const area = screen.getByTestId("drop-area");

    // Enter parent, then enter a child before leaving the parent: net depth
    // stays positive, so the overlay should not flicker off.
    fireEvent.dragEnter(area);
    fireEvent.dragEnter(area);
    fireEvent.dragLeave(area);
    expect(area).toHaveTextContent("dragging");
  });

  it("clears dragging on drop", () => {
    render(<Harness />);
    const area = screen.getByTestId("drop-area");

    fireEvent.dragEnter(area);
    act(() => {
      fireEvent.drop(area, { dataTransfer: { files: [] } });
    });
    expect(area).toHaveTextContent("idle");
  });
});
