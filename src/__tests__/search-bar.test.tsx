import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SearchBar } from "@/components/search-bar";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSearchBar(initialEntry = "/") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SearchBar />
    </MemoryRouter>
  );
}

describe("SearchBar", () => {
  it("renders an input and a submit button", () => {
    renderSearchBar();
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /search/i })).toBeInTheDocument();
  });

  it("navigates to /search with query on submit", () => {
    renderSearchBar();
    const input = screen.getByPlaceholderText(/search/i);

    fireEvent.change(input, { target: { value: "barcelona" } });
    fireEvent.submit(input.closest("form")!);

    expect(mockNavigate).toHaveBeenCalledWith("/search?q=barcelona");
  });

  it("trims whitespace from the query", () => {
    renderSearchBar();
    const input = screen.getByPlaceholderText(/search/i);

    fireEvent.change(input, { target: { value: "  city  " } });
    fireEvent.submit(input.closest("form")!);

    expect(mockNavigate).toHaveBeenCalledWith("/search?q=city");
  });

  it("does not navigate when query is empty", () => {
    renderSearchBar();
    const input = screen.getByPlaceholderText(/search/i);

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("encodes special characters in the query", () => {
    renderSearchBar();
    const input = screen.getByPlaceholderText(/search/i);

    fireEvent.change(input, { target: { value: "foo&bar" } });
    fireEvent.submit(input.closest("form")!);

    expect(mockNavigate).toHaveBeenCalledWith("/search?q=foo%26bar");
  });

  it("initializes with the q param from the URL", () => {
    renderSearchBar("/search?q=landscape");

    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
    expect(input.value).toBe("landscape");
  });
});
