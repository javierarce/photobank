import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SortDropdown } from "@/components/sort-dropdown";

afterEach(() => {
  cleanup();
});

describe("SortDropdown", () => {
  it("shows the current option's label", () => {
    render(<SortDropdown value="name-asc" onChange={vi.fn()} />);
    expect(screen.getByLabelText("Sort photos")).toHaveTextContent("Name (A–Z)");
  });

  it("opens the menu and lists every option", () => {
    render(<SortDropdown value="date-desc" onChange={vi.fn()} />);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Sort photos"));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Newest first/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Oldest first/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Name \(A–Z\)/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /Name \(Z–A\)/ })).toBeInTheDocument();
  });

  it("reports the active option via aria-checked", () => {
    render(<SortDropdown value="date-asc" onChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Sort photos"));

    expect(
      screen.getByRole("menuitemradio", { name: /Oldest first/ })
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("menuitemradio", { name: /Newest first/ })
    ).toHaveAttribute("aria-checked", "false");
  });

  it("calls onChange and closes the menu when an option is chosen", () => {
    const onChange = vi.fn();
    render(<SortDropdown value="date-desc" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Sort photos"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Name \(A–Z\)/ }));

    expect(onChange).toHaveBeenCalledWith("name-asc");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape without changing the sort", () => {
    const onChange = vi.fn();
    render(<SortDropdown value="date-desc" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Sort photos"));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("swallows Escape so it doesn't reach bubble-phase document handlers", () => {
    const outerEscape = vi.fn();
    const onOuterKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") outerEscape();
    };
    document.addEventListener("keydown", onOuterKeyDown);
    try {
      render(<SortDropdown value="date-desc" onChange={vi.fn()} />);
      const trigger = screen.getByLabelText("Sort photos");
      fireEvent.click(trigger);
      expect(screen.getByRole("menu")).toBeInTheDocument();

      fireEvent.keyDown(trigger, { key: "Escape" });

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(outerEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", onOuterKeyDown);
    }
  });

  it("closes when clicking outside", () => {
    render(
      <div>
        <SortDropdown value="date-desc" onChange={vi.fn()} />
        <button type="button">elsewhere</button>
      </div>
    );

    fireEvent.click(screen.getByLabelText("Sort photos"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText("elsewhere"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
