import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { PhotoGrid } from "@/components/photo-grid";
import { listPhotos } from "@/lib/api";
import type { Photo } from "@/lib/types";
import { makePhoto } from "./fixtures";

vi.mock("@/lib/api", () => ({
  listPhotos: vi.fn(),
  deletePhoto: vi.fn(),
  updatePhoto: vi.fn(),
}));

vi.mock("@/components/photo-lightbox", () => ({
  PhotoLightbox: () => <div data-testid="lightbox" />,
}));

const mockListPhotos = vi.mocked(listPhotos);

const mockPhotos: Photo[] = [
  makePhoto({
    id: "1",
    filename: "beach.jpg",
    s3Key: "vacation/beach.jpg",
    folder: "vacation",
  }),
  makePhoto({
    id: "2",
    filename: "pending.jpg",
    s3Key: "vacation/pending.jpg",
    folder: "vacation",
    width: null,
    height: null,
    processingStatus: "pending",
  }),
  makePhoto({
    id: "3",
    filename: "failed.jpg",
    s3Key: "vacation/failed.jpg",
    folder: "vacation",
    width: null,
    height: null,
    processingStatus: "failed",
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("PhotoGrid", () => {
  it("shows loading state initially", () => {
    mockListPhotos.mockReturnValueOnce(new Promise(() => {}));
    render(<PhotoGrid folder="vacation" />);

    expect(screen.getByText("Loading photos...")).toBeInTheDocument();
  });

  it("shows empty state when folder has no photos", async () => {
    mockListPhotos.mockResolvedValueOnce([]);

    render(<PhotoGrid folder="empty" />);

    await waitFor(() => {
      expect(
        screen.getByText("No photos in this folder.")
      ).toBeInTheDocument();
    });
  });

  it("renders completed photos as images", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);

    render(<PhotoGrid folder="vacation" />);

    await waitFor(() => {
      expect(screen.getByAltText("beach.jpg")).toBeInTheDocument();
    });
  });

  it("shows processing status for non-completed photos", async () => {
    mockListPhotos.mockResolvedValueOnce(mockPhotos);

    render(<PhotoGrid folder="vacation" />);

    await waitFor(() => {
      expect(screen.getByText("Pending...")).toBeInTheDocument();
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });
  });

  it("loads photos for the correct folder", async () => {
    mockListPhotos.mockResolvedValueOnce([]);

    render(<PhotoGrid folder="barcelona" />);

    await waitFor(() => {
      expect(mockListPhotos).toHaveBeenCalledWith("barcelona");
    });
  });

  it("shows an error message when loading fails", async () => {
    mockListPhotos.mockRejectedValueOnce("boom");

    render(<PhotoGrid folder="vacation" />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load photos.")).toBeInTheDocument();
    });
  });
});
