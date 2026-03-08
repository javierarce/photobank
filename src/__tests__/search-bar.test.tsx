import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SearchBar } from "@/components/search-bar";

const mockPush = vi.fn();
const mockGet = vi.fn().mockReturnValue(null);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => ({ get: mockGet }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SearchBar", () => {
  it("renders an input and a submit button", () => {
    render(<SearchBar />);
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /search/i })).toBeInTheDocument();
  });

  it("navigates to /search with query on submit", () => {
    render(<SearchBar />);
    const input = screen.getByPlaceholderText(/search/i);

    fireEvent.change(input, { target: { value: "barcelona" } });
    fireEvent.submit(input.closest("form")!);

    expect(mockPush).toHaveBeenCalledWith("/search?q=barcelona");
  });

  it("trims whitespace from the query", () => {
    render(<SearchBar />);
    const input = screen.getByPlaceholderText(/search/i);

    fireEvent.change(input, { target: { value: "  city  " } });
    fireEvent.submit(input.closest("form")!);

    expect(mockPush).toHaveBeenCalledWith("/search?q=city");
  });

  it("does not navigate when query is empty", () => {
    render(<SearchBar />);
    const input = screen.getByPlaceholderText(/search/i);

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);

    expect(mockPush).not.toHaveBeenCalled();
  });

  it("encodes special characters in the query", () => {
    render(<SearchBar />);
    const input = screen.getByPlaceholderText(/search/i);

    fireEvent.change(input, { target: { value: "foo&bar" } });
    fireEvent.submit(input.closest("form")!);

    expect(mockPush).toHaveBeenCalledWith("/search?q=foo%26bar");
  });

  it("initializes with the q param from the URL", () => {
    mockGet.mockReturnValue("landscape");
    render(<SearchBar />);

    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
    expect(input.value).toBe("landscape");
  });
});
