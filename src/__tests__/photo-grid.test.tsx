import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { PhotoGrid } from "@/components/photo-grid";
import { listPhotos } from "@/lib/api";
import type { Photo } from "@/lib/types";
import type { UploadFile } from "@/hooks/use-upload";
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

// An in-flight import tile. Unlike the old web flow there is no local File or
// object URL — native drag-drop gives paths, so the tile shows the filename
// until the processed thumbnail takes over.
function makeUpload(overrides: Partial<UploadFile> = {}): UploadFile {
  return {
    key: "u1",
    folder: "vacation",
    filename: "beach.jpg",
    status: "done",
    progress: 100,
    ...overrides,
  };
}

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

  it("keeps the upload tile instead of the Pending photo tile while processing", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[1]]);

    const upload = makeUpload({ id: "2", filename: "pending.jpg" });
    render(<PhotoGrid folder="vacation" uploads={[upload]} />);

    await waitFor(() => {
      expect(screen.getByText("Processing…")).toBeInTheDocument();
    });
    // The upload tile shows the filename; the photo's own "Pending..." tile
    // stays hidden until the tile hands off.
    expect(screen.getByText("pending.jpg")).toBeInTheDocument();
    expect(screen.queryByText("Pending...")).not.toBeInTheDocument();
  });

  it("dismisses the upload only after the real thumbnail has loaded", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);

    const onDismiss = vi.fn();
    const upload = makeUpload({ id: "1" });
    const { container } = render(
      <PhotoGrid folder="vacation" uploads={[upload]} onDismissUpload={onDismiss} />
    );

    // Photo is completed, but the upload tile stays until the variant loads
    await waitFor(() => {
      expect(container.querySelector("img.hidden")).toBeInTheDocument();
    });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.load(container.querySelector("img.hidden")!);
    expect(onDismiss).toHaveBeenCalledWith("u1");
  });

  it("dismisses the upload when processing fails so the photo tile shows the error", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[2]]);

    const onDismiss = vi.fn();
    const upload = makeUpload({ id: "3", filename: "failed.jpg" });
    render(
      <PhotoGrid folder="vacation" uploads={[upload]} onDismissUpload={onDismiss} />
    );

    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalledWith("u1");
    });
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});
