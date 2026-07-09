import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Header } from "@/components/header";

afterEach(() => {
  cleanup();
});

function renderHeader() {
  return render(
    <MemoryRouter>
      <Header />
    </MemoryRouter>
  );
}

describe("Header", () => {
  it("renders the Photobank link", () => {
    renderHeader();

    const link = screen.getByText("Photobank");
    expect(link).toBeInTheDocument();
    expect(link.closest("a")?.getAttribute("href")).toBe("/");
  });

  it("renders the search bar", () => {
    renderHeader();

    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
  });
});
