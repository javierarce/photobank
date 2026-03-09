import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { PhotoGrid } from "@/components/photo-grid";
import type { Photo } from "@/lib/types";

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
    filename: "pending.jpg",
    s3Key: "vacation/pending.jpg",
    folder: "vacation",
    width: null,
    height: null,
    processingStatus: "pending",
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
    id: "3",
    filename: "failed.jpg",
    s3Key: "vacation/failed.jpg",
    folder: "vacation",
    width: null,
    height: null,
    processingStatus: "failed",
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
];

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("PhotoGrid", () => {
  it("shows loading state initially", () => {
    vi.spyOn(global, "fetch").mockReturnValueOnce(new Promise(() => {}));
    render(<PhotoGrid folder="vacation" />);

    expect(screen.getByText("Loading photos...")).toBeInTheDocument();
  });

  it("shows empty state when folder has no photos", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      json: () => Promise.resolve({ photos: [] }),
    } as Response);

    render(<PhotoGrid folder="empty" />);

    await waitFor(() => {
      expect(
        screen.getByText("No photos in this folder.")
      ).toBeInTheDocument();
    });
  });

  it("renders completed photos as images", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      json: () => Promise.resolve({ photos: [mockPhotos[0]] }),
    } as Response);

    render(<PhotoGrid folder="vacation" />);

    await waitFor(() => {
      expect(screen.getByAltText("beach.jpg")).toBeInTheDocument();
    });
  });

  it("shows processing status for non-completed photos", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      json: () => Promise.resolve({ photos: mockPhotos }),
    } as Response);

    render(<PhotoGrid folder="vacation" />);

    await waitFor(() => {
      expect(screen.getByText("Pending...")).toBeInTheDocument();
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });
  });

  it("fetches photos for the correct folder", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      json: () => Promise.resolve({ photos: [] }),
    } as Response);

    render(<PhotoGrid folder="barcelona" />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/photos?folder=barcelona"
      );
    });
  });

  it("encodes folder name in API request", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      json: () => Promise.resolve({ photos: [] }),
    } as Response);

    render(<PhotoGrid folder="my photos" />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/photos?folder=my%20photos"
      );
    });
  });
});
