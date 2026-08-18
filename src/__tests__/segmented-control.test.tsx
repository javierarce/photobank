import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SegmentedControl } from "@/components/segmented-control";

const options = [
  { value: "all", label: "All" },
  { value: "landscape", label: "Landscape" },
  { value: "portrait", label: "Portrait" },
] as const;

afterEach(() => {
  cleanup();
});

function renderControl(value: (typeof options)[number]["value"] = "all") {
  const onChange = vi.fn();
  render(
    <SegmentedControl
      value={value}
      options={options}
      onChange={onChange}
      label="Filter by orientation"
    />
  );
  return onChange;
}

describe("SegmentedControl", () => {
  it("shows every option at once, with the current one checked", () => {
    renderControl("portrait");

    const group = screen.getByRole("radiogroup", {
      name: "Filter by orientation",
    });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "All" })).toHaveAttribute(
      "aria-checked",
      "false"
    );
    expect(screen.getByRole("radio", { name: "Portrait" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });

  it("reports the segment that was clicked", () => {
    const onChange = renderControl("all");

    fireEvent.click(screen.getByRole("radio", { name: "Landscape" }));

    expect(onChange).toHaveBeenCalledWith("landscape");
  });

  it("is one Tab stop: only the current segment is reachable by Tab", () => {
    renderControl("landscape");

    expect(screen.getByRole("radio", { name: "All" })).toHaveAttribute(
      "tabindex",
      "-1"
    );
    expect(screen.getByRole("radio", { name: "Landscape" })).toHaveAttribute(
      "tabindex",
      "0"
    );
  });

  it("moves between segments with the arrow keys, wrapping around", () => {
    const onChange = renderControl("all");
    const group = screen.getByRole("radiogroup");

    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("landscape");

    // Left from the first option wraps to the last.
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("portrait");
  });

  it("leaves other keys to whatever else is listening", () => {
    const onChange = renderControl("all");

    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "Escape" });

    expect(onChange).not.toHaveBeenCalled();
  });
});
