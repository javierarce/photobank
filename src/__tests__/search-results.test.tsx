import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { SearchResults } from "@/components/search-results";
import type { Photo } from "@/lib/types";

const mockSearchParams = new Map<string, string>();

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => mockSearchParams.get(key) || "",
  }),
}));

vi.mock("@/components/photo-lightbox", () => ({
  PhotoLightbox: () => <div data-testid="lightbox" />,
}));

const mockPhotos: Photo[] = [
  {
    id: "1",
    filename: "beach.jpg",
    s3Key: "vacation/beach.jpg",
    folder: "vacation",
    width: 1920,
    height: 1080,
    processingStatus: "completed",
    cameraMake: null,
    cameraModel: null,
    lens: null,
    focalLength: null,
    aperture: null,
    shutterSpeed: null,
    iso: null,
    takenAt: null,
    gpsLatitude: null,
    gpsLongitude: null,
  },
  {
    id: "2",
    filename: "mountain.jpg",
    s3Key: "nature/mountain.jpg",
    folder: "nature",
    width: 3000,
    height: 2000,
    processingStatus: "completed",
    cameraMake: "Canon",
    cameraModel: "EOS R5",
    lens: null,
    focalLength: null,
    aperture: null,
    shutterSpeed: null,
    iso: null,
    takenAt: null,
    gpsLatitude: null,
    gpsLongitude: null,
  },
];

beforeEach(() => {
  mockSearchParams.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SearchResults", () => {
  it("shows prompt when no search term is provided", () => {
    render(<SearchResults />);
    expect(screen.getByText("Enter a search term.")).toBeInTheDocument();
  });

  it("fetches and displays results when q is set", async () => {
    mockSearchParams.set("q", "beach");
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      json: () => Promise.resolve({ photos: [mockPhotos[0]] }),
    } as Response);

    render(<SearchResults />);

    await waitFor(() => {
      expect(screen.getByText("beach.jpg")).toBeInTheDocument();
    });
    expect(screen.getByText("1 result")).toBeInTheDocument();
  });

  it("fetches and displays results when tag is set", async () => {
    mockSearchParams.set("tag", "landscape");
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      json: () => Promise.resolve({ photos: mockPhotos }),
    } as Response);

    render(<SearchResults />);

    await waitFor(() => {
      expect(screen.getByText("beach.jpg")).toBeInTheDocument();
      expect(screen.getByText("mountain.jpg")).toBeInTheDocument();
    });
    expect(screen.getByText("2 results")).toBeInTheDocument();
  });

  it("shows no results message when search returns empty", async () => {
    mockSearchParams.set("q", "nonexistent");
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      json: () => Promise.resolve({ photos: [] }),
    } as Response);

    render(<SearchResults />);

    await waitFor(() => {
      expect(screen.getByText("No results found.")).toBeInTheDocument();
    });
  });

  it("shows loading state while fetching", () => {
    mockSearchParams.set("q", "test");
    vi.spyOn(global, "fetch").mockReturnValueOnce(new Promise(() => {}));

    render(<SearchResults />);

    expect(screen.getByText("Searching...")).toBeInTheDocument();
  });

  it("passes correct query params to the API", async () => {
    mockSearchParams.set("q", "sunset");
    mockSearchParams.set("tag", "golden-hour");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      json: () => Promise.resolve({ photos: [] }),
    } as Response);

    render(<SearchResults />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/search?q=sunset&tag=golden-hour");
    });
  });
});
