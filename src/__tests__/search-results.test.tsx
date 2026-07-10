import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SearchResults } from "@/components/search-results";
import { searchPhotos } from "@/lib/api";
import type { Photo } from "@/lib/types";
import { makePhoto } from "./fixtures";

vi.mock("@/lib/api", () => ({
  searchPhotos: vi.fn(),
  exportPhotos: vi.fn(),
  deletePhoto: vi.fn(),
  updatePhoto: vi.fn(),
}));

vi.mock("@/components/photo-lightbox", () => ({
  PhotoLightbox: () => <div data-testid="lightbox" />,
}));

const mockSearchPhotos = vi.mocked(searchPhotos);

const mockPhotos: Photo[] = [
  makePhoto({
    id: "1",
    filename: "beach.jpg",
    s3Key: "vacation/beach.jpg",
    folder: "vacation",
  }),
  makePhoto({
    id: "2",
    filename: "mountain.jpg",
    s3Key: "nature/mountain.jpg",
    folder: "nature",
    width: 3000,
    height: 2000,
    cameraMake: "Canon",
    cameraModel: "EOS R5",
  }),
];

function renderSearch(params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  return render(
    <MemoryRouter initialEntries={[query ? `/search?${query}` : "/search"]}>
      <SearchResults />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("SearchResults", () => {
  it("shows prompt when no search term is provided", () => {
    renderSearch();
    expect(screen.getByText("Enter a search term.")).toBeInTheDocument();
  });

  it("fetches and displays results when q is set", async () => {
    mockSearchPhotos.mockResolvedValueOnce([mockPhotos[0]]);

    renderSearch({ q: "beach" });

    await waitFor(() => {
      expect(screen.getByText("beach.jpg")).toBeInTheDocument();
    });
    expect(screen.getByText("1 result")).toBeInTheDocument();
  });

  it("fetches and displays results when tag is set", async () => {
    mockSearchPhotos.mockResolvedValueOnce(mockPhotos);

    renderSearch({ tag: "landscape" });

    await waitFor(() => {
      expect(screen.getByText("beach.jpg")).toBeInTheDocument();
      expect(screen.getByText("mountain.jpg")).toBeInTheDocument();
    });
    expect(screen.getByText("2 results")).toBeInTheDocument();
  });

  it("shows no results message when search returns empty", async () => {
    mockSearchPhotos.mockResolvedValueOnce([]);

    renderSearch({ q: "nonexistent" });

    await waitFor(() => {
      expect(screen.getByText("No results found.")).toBeInTheDocument();
    });
  });

  it("shows loading state while fetching", () => {
    mockSearchPhotos.mockReturnValueOnce(new Promise(() => {}));

    renderSearch({ q: "test" });

    expect(screen.getByText("Searching...")).toBeInTheDocument();
  });

  it("shows an error message when the search fails", async () => {
    mockSearchPhotos.mockRejectedValueOnce("boom");

    renderSearch({ q: "sunset" });

    await waitFor(() => {
      expect(screen.getByText("Search failed.")).toBeInTheDocument();
    });
  });

  it("passes correct query params to the API", async () => {
    mockSearchPhotos.mockResolvedValueOnce([]);

    renderSearch({ q: "sunset", tag: "golden-hour" });

    await waitFor(() => {
      expect(mockSearchPhotos).toHaveBeenCalledWith({
        q: "sunset",
        tag: "golden-hour",
      });
    });
  });
});
