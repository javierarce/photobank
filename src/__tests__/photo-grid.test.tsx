import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render as rtlRender,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { SelectionProvider } from "@/hooks/selection-provider";
import { PhotoGrid } from "@/components/photo-grid";

// The grid reads multi-select state from context, so every render needs the
// provider around it.
function render(ui: Parameters<typeof rtlRender>[0]) {
  return rtlRender(ui, { wrapper: SelectionProvider });
}
import { listPhotos } from "@/lib/api";
import type { Photo } from "@/lib/types";
import type { UploadFile } from "@/hooks/use-upload";
import { makePhoto } from "./fixtures";

vi.mock("@/lib/api", () => ({
  listPhotos: vi.fn(),
  deletePhoto: vi.fn(),
  updatePhoto: vi.fn(),
}));

// A minimal stand-in that surfaces the active photo and the nav callbacks the
// grid wires up, so tests can exercise wrap-around navigation.
vi.mock("@/components/photo-lightbox", () => ({
  PhotoLightbox: ({
    photo,
    onPrev,
    onNext,
  }: {
    photo: { filename: string };
    onPrev?: () => void;
    onNext?: () => void;
  }) => (
    <div data-testid="lightbox">
      <span data-testid="lightbox-filename">{photo.filename}</span>
      <button onClick={onPrev} disabled={!onPrev}>
        prev
      </button>
      <button onClick={onNext} disabled={!onNext}>
        next
      </button>
    </div>
  ),
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

  it("keeps thumbnail tiles unfilled in light mode and gray only in dark", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);

    render(<PhotoGrid folder="vacation" />);

    await waitFor(() => {
      expect(screen.getByAltText("beach.jpg")).toBeInTheDocument();
    });

    // No gray frame around thumbnails in light mode — the tile fill is a
    // foreground color at 0% opacity, with the subtle placeholder kept for dark
    // mode only.
    const tile = screen.getByAltText("beach.jpg").closest(".photo-tile");
    expect(tile).toHaveClass("bg-foreground/0", "dark:bg-foreground/5");
    expect(tile).not.toHaveClass("bg-foreground/5");
  });

  it("wraps around when navigating past the ends of the folder", async () => {
    mockListPhotos.mockResolvedValueOnce(mockPhotos);

    render(<PhotoGrid folder="vacation" />);

    await waitFor(() => {
      expect(screen.getByAltText("beach.jpg")).toBeInTheDocument();
    });

    // Open the first photo.
    fireEvent.dblClick(screen.getByAltText("beach.jpg"));
    expect(screen.getByTestId("lightbox-filename")).toHaveTextContent(
      "beach.jpg"
    );

    // Going back from the first photo wraps to the last.
    fireEvent.click(screen.getByText("prev"));
    expect(screen.getByTestId("lightbox-filename")).toHaveTextContent(
      "failed.jpg"
    );

    // And forward from the last wraps back to the first.
    fireEvent.click(screen.getByText("next"));
    expect(screen.getByTestId("lightbox-filename")).toHaveTextContent(
      "beach.jpg"
    );
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

  it("offers a Cancel button on an in-flight tile and reports its key", async () => {
    mockListPhotos.mockResolvedValueOnce([]);

    const onCancel = vi.fn();
    const upload = makeUpload({ status: "uploading", progress: 30 });
    render(
      <PhotoGrid folder="vacation" uploads={[upload]} onCancelUpload={onCancel} />
    );

    await waitFor(() => {
      expect(screen.getByText("30%")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledWith("u1");
  });

  it("shows Cancelling… and no Cancel button once cancellation is under way", async () => {
    mockListPhotos.mockResolvedValueOnce([]);

    const onCancel = vi.fn();
    const upload = makeUpload({ status: "cancelling", progress: 30 });
    render(
      <PhotoGrid folder="vacation" uploads={[upload]} onCancelUpload={onCancel} />
    );

    await waitFor(() => {
      expect(screen.getByText("Cancelling…")).toBeInTheDocument();
    });
    expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
  });

  it("does not offer Cancel on a done (uploaded, processing) tile", async () => {
    mockListPhotos.mockResolvedValueOnce([]);

    const upload = makeUpload({ status: "done", progress: 100 });
    render(
      <PhotoGrid folder="vacation" uploads={[upload]} onCancelUpload={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText("Processing…")).toBeInTheDocument();
    });
    expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
  });
});
