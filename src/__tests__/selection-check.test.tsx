import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { SelectionCheck } from "@/components/selection-check";

afterEach(() => {
  cleanup();
});

describe("SelectionCheck", () => {
  it("animates the badge in when it appears on a selected tile", () => {
    const { container } = render(<SelectionCheck />);

    // The badge settles in with a scale+fade (via `badge-in`) rather than
    // popping onto the thumbnail from nothing.
    expect(container.firstElementChild).toHaveClass("badge-in");
  });

  it("does not intercept clicks meant for the thumbnail underneath", () => {
    const { container } = render(<SelectionCheck />);

    expect(container.firstElementChild).toHaveClass("pointer-events-none");
  });
});
