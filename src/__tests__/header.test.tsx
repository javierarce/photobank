import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Header } from "@/components/header";

afterEach(() => {
  cleanup();
});

function renderHeader(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Header />
    </MemoryRouter>
  );
}

describe("Header", () => {
  it("renders Folders, Tags, and Settings nav links", () => {
    renderHeader();

    const folders = screen.getByText("Folders");
    const tags = screen.getByText("Tags");
    const settings = screen.getByText("Settings");
    expect(folders.closest("a")?.getAttribute("href")).toBe("/");
    expect(tags.closest("a")?.getAttribute("href")).toBe("/tags");
    expect(settings.closest("a")?.getAttribute("href")).toBe("/settings");
  });

  it("no longer shows the app title or a search field", () => {
    renderHeader();

    expect(screen.queryByText("Photobank")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
  });

  it("shares the .app-row layout with the page content below", () => {
    renderHeader();

    const row = screen.getByText("Folders").closest("div");
    // .app-row gives the header the same centered column and side padding as
    // the pages; .app-header is what shifts it clear of the traffic lights on
    // narrow windows, instead of a hardcoded left inset.
    expect(row?.className).toContain("app-row");
    expect(row?.className).not.toContain("pl-24");
    expect(row?.closest("header")?.className).toContain("app-header");
  });

  it("marks the active route", () => {
    renderHeader("/tags");
    // NavLink sets aria-current="page" on the active link.
    expect(screen.getByText("Tags").closest("a")).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByText("Folders").closest("a")).not.toHaveAttribute(
      "aria-current"
    );
  });
});
