import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ExportButton } from "@/components/export-button";

afterEach(() => {
  cleanup();
});

describe("ExportButton", () => {
  it("exports the default (2880) version on a plain click", () => {
    const onExport = vi.fn();
    render(<ExportButton onExport={onExport} />);

    fireEvent.click(screen.getByText("Download"));
    expect(onExport).toHaveBeenCalledWith("2880");
  });

  it("uses a custom label", () => {
    render(<ExportButton onExport={vi.fn()} label="Export" />);
    expect(screen.getByText("Export")).toBeInTheDocument();
  });

  it("opens a version menu from the caret and hides it initially", () => {
    render(<ExportButton onExport={vi.fn()} />);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Choose version to export"));

    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Original/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /2880/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /1280/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /640/ })).toBeInTheDocument();
  });

  it("exports the chosen version and closes the menu", () => {
    const onExport = vi.fn();
    render(<ExportButton onExport={onExport} />);

    fireEvent.click(screen.getByLabelText("Choose version to export"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Original/ }));

    expect(onExport).toHaveBeenCalledWith("original");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("exports a specific resolution from the menu", () => {
    const onExport = vi.fn();
    render(<ExportButton onExport={onExport} />);

    fireEvent.click(screen.getByLabelText("Choose version to export"));
    fireEvent.click(screen.getByRole("menuitem", { name: /1280/ }));

    expect(onExport).toHaveBeenCalledWith("1280");
  });

  it("closes the menu on Escape without exporting", () => {
    const onExport = vi.fn();
    render(<ExportButton onExport={onExport} />);

    fireEvent.click(screen.getByLabelText("Choose version to export"));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onExport).not.toHaveBeenCalled();
  });

  it("swallows the Escape keypress so it doesn't reach bubble-phase document handlers", () => {
    // Stand in for the lightbox-close / selection-clear listeners, which are
    // registered on document in the bubble phase. Registered before the menu
    // opens, so only capture-phase ordering (not registration order) can keep
    // the menu's handler ahead of it.
    const outerEscape = vi.fn();
    const onOuterKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") outerEscape();
    };
    document.addEventListener("keydown", onOuterKeyDown);
    try {
      render(<ExportButton onExport={vi.fn()} />);

      const caret = screen.getByLabelText("Choose version to export");
      fireEvent.click(caret);
      expect(screen.getByRole("menu")).toBeInTheDocument();

      // Dispatch from the focused element so the event actually propagates
      // through capture -> target -> bubble (unlike dispatching on document).
      fireEvent.keyDown(caret, { key: "Escape" });

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(outerEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", onOuterKeyDown);
    }
  });

  it("closes the menu when clicking outside", () => {
    render(
      <div>
        <ExportButton onExport={vi.fn()} />
        <button type="button">elsewhere</button>
      </div>
    );

    fireEvent.click(screen.getByLabelText("Choose version to export"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText("elsewhere"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("reflects the open state via aria-expanded", () => {
    render(<ExportButton onExport={vi.fn()} />);
    const caret = screen.getByLabelText("Choose version to export");

    expect(caret).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(caret);
    expect(caret).toHaveAttribute("aria-expanded", "true");
  });

  it("disables both halves when disabled", () => {
    render(<ExportButton onExport={vi.fn()} disabled />);
    expect(screen.getByText("Download")).toBeDisabled();
    expect(screen.getByLabelText("Choose version to export")).toBeDisabled();
  });
});
