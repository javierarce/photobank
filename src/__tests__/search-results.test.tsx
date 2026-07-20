import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SelectionProvider } from "@/hooks/selection-provider";
import { SearchResults } from "@/components/search-results";
import {
  searchPhotos,
  getTagsForPhotos,
  listTags,
  removeTagsFromPhotos,
} from "@/lib/api";
import type { Photo } from "@/lib/types";
import { makePhoto } from "./fixtures";

vi.mock("@/lib/api", () => ({
  searchPhotos: vi.fn(),
  exportPhotos: vi.fn(),
  deletePhoto: vi.fn(),
  updatePhoto: vi.fn(),
  getTagsForPhotos: vi.fn(),
  listTags: vi.fn(),
  addTagsToPhotos: vi.fn(),
  removeTagsFromPhotos: vi.fn(),
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
    <SelectionProvider>
      <MemoryRouter initialEntries={[query ? `/search?${query}` : "/search"]}>
        <SearchResults />
      </MemoryRouter>
    </SelectionProvider>
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

  it("warns that metadata filters need loaded info", async () => {
    mockSearchPhotos.mockResolvedValueOnce([mockPhotos[1]]);

    renderSearch({ q: "iso:>=800" });

    await waitFor(() => {
      expect(
        screen.getByText(/metadata filters only match photos/i)
      ).toBeInTheDocument();
    });
  });

  it("omits the metadata caveat for non-EXIF queries", async () => {
    mockSearchPhotos.mockResolvedValueOnce([mockPhotos[0]]);

    renderSearch({ q: "beach" });

    await waitFor(() => {
      expect(screen.getByText("beach.jpg")).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/metadata filters only match photos/i)
    ).not.toBeInTheDocument();
  });

  it("re-runs the search after a bulk tag edit so unmatching photos drop out", async () => {
    vi.mocked(listTags).mockResolvedValue([{ id: "t1", name: "sunset" }]);
    vi.mocked(getTagsForPhotos).mockResolvedValue({
      "1": [{ id: "t1", name: "sunset" }],
      "2": [{ id: "t1", name: "sunset" }],
    });
    vi.mocked(removeTagsFromPhotos).mockResolvedValue(undefined);
    // First load matches both; after removing the tag the query matches none.
    mockSearchPhotos
      .mockResolvedValueOnce(mockPhotos)
      .mockResolvedValueOnce([]);

    renderSearch({ q: "tag:sunset" });
    await screen.findByText("beach.jpg");

    // Select everything, then open the bulk tag editor (Cmd+A, then T).
    fireEvent.keyDown(document.body, { key: "a", metaKey: true });
    fireEvent.keyDown(document.body, { key: "t" });

    // Uncheck the fully-applied "sunset" to remove it, then Apply.
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(removeTagsFromPhotos).toHaveBeenCalled());
    // The search re-runs and the now-unmatching photos are gone.
    await waitFor(() => expect(mockSearchPhotos).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No results found.")).toBeInTheDocument();
  });
});
