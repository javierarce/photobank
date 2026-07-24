import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render as rtlRender,
  screen,
  cleanup,
  waitFor,
  fireEvent,
  act,
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
  REFRESH_PROGRESS_EVENT: "refresh://progress",
}));

// The grid subscribes to refresh://progress to reload once a library refresh
// settles; capture the handler so tests can emit events.
const hoisted = vi.hoisted(() => ({
  refreshListener: null as null | ((event: { payload: unknown }) => void),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, cb: (event: { payload: unknown }) => void) => {
    hoisted.refreshListener = cb;
    return Promise.resolve(() => {});
  },
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

  it("falls back to the original image when the thumbnail variant is missing", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);

    render(<PhotoGrid folder="vacation" />);

    const img = await screen.findByAltText("beach.jpg");
    expect(img).toHaveAttribute(
      "src",
      "photo://localhost/vacation/beach_640.webp"
    );

    // A photo synced into the bucket externally has no variants yet — the
    // 640px request 404s and the tile must degrade to the original object
    // instead of a broken image.
    fireEvent.error(img);
    expect(img).toHaveAttribute("src", "photo://localhost/vacation/beach.jpg");
  });

  it("keeps the image hidden until it loads so no broken glyph shows", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);

    render(<PhotoGrid folder="vacation" />);

    const img = await screen.findByAltText("beach.jpg");
    // Before it loads — or if it never loads — the picture is invisible and
    // the on-brand placeholder shows in its place, so a missing/slow/broken
    // image never surfaces the browser's broken glyph.
    expect(img).toHaveClass("opacity-0");
    expect(screen.getByTestId("thumbnail-fallback")).toBeInTheDocument();

    // Once it actually loads, the picture fades in over the placeholder.
    fireEvent.load(img);
    expect(img).toHaveClass("opacity-100");
    expect(screen.queryByTestId("thumbnail-fallback")).not.toBeInTheDocument();
  });

  it("stays on the placeholder when both the variant and original are missing", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);

    render(<PhotoGrid folder="vacation" />);

    const img = await screen.findByAltText("beach.jpg");
    // Variant 404s → fall back to the original.
    fireEvent.error(img);
    expect(img).toHaveAttribute("src", "photo://localhost/vacation/beach.jpg");

    // The original 404s too — the image never loads, so it stays hidden and
    // the quiet placeholder remains rather than a broken-image glyph.
    fireEvent.error(img);
    expect(img).toHaveClass("opacity-0");
    expect(screen.getByTestId("thumbnail-fallback")).toBeInTheDocument();
  });

  it("remounts a loaded thumbnail when a refresh bumps updated_at", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);

    render(<PhotoGrid folder="vacation" />);
    const img = await screen.findByAltText("beach.jpg");
    // The 640px variant loaded fine — no fallback, so src never changed.
    fireEvent.load(img);
    expect(img).toHaveClass("opacity-100");

    // A refresh regenerates variants under the same key and bumps updated_at.
    // The src is identical, so a real browser won't re-fire onLoad on the same
    // element; the tile must remount (new node) to reload, or the placeholder
    // would be stranded over a perfectly good thumbnail. Assert the remount
    // rather than firing load — jsdom re-fires onLoad on demand and so can't
    // reproduce the stranding on its own.
    mockListPhotos.mockResolvedValueOnce([
      { ...mockPhotos[0], updatedAt: "2026-07-18T00:00:00Z" },
    ]);
    await act(async () => {
      hoisted.refreshListener?.({
        payload: { total: 1, done: 1, failed: 0, status: "done" },
      });
    });

    // A fresh img element (keyed on the marker) replaces the old one and starts
    // hidden until it reloads — proving it can re-fire onLoad on the same src.
    const refreshed = await screen.findByAltText("beach.jpg");
    expect(refreshed).not.toBe(img);
    expect(refreshed).toHaveClass("opacity-0");
    fireEvent.load(refreshed);
    expect(refreshed).toHaveClass("opacity-100");
    expect(screen.queryByTestId("thumbnail-fallback")).not.toBeInTheDocument();
  });

  it("retries the variant after a refresh touches a fallen-back photo", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);

    render(<PhotoGrid folder="vacation" />);
    const img = await screen.findByAltText("beach.jpg");
    fireEvent.error(img);
    expect(img).toHaveAttribute("src", "photo://localhost/vacation/beach.jpg");

    // The refresh regenerated the variants under the same key and bumped
    // updated_at; the reload it triggers must swap the tile off the original.
    mockListPhotos.mockResolvedValueOnce([
      { ...mockPhotos[0], updatedAt: "2026-07-18T00:00:00Z" },
    ]);
    await act(async () => {
      hoisted.refreshListener?.({
        payload: { total: 1, done: 1, failed: 0, status: "done" },
      });
    });
    await waitFor(() =>
      expect(screen.getByAltText("beach.jpg")).toHaveAttribute(
        "src",
        "photo://localhost/vacation/beach_640.webp"
      )
    );
  });

  it("addresses old-scheme originals' variants without the _original marker", async () => {
    mockListPhotos.mockResolvedValueOnce([
      makePhoto({
        id: "old",
        filename: "R0007098_original.jpg",
        s3Key: "calella/R0007098_original.jpg",
        folder: "calella",
      }),
    ]);

    render(<PhotoGrid folder="calella" />);

    // The old web pipeline stored "<base>_original.jpg" + "<base>_640.webp";
    // the thumbnail must strip the marker to find the existing variant.
    const img = await screen.findByAltText("R0007098_original.jpg");
    expect(img).toHaveAttribute(
      "src",
      "photo://localhost/calella/R0007098_640.webp"
    );
  });

  it("reloads the folder once a library refresh settles", async () => {
    mockListPhotos.mockResolvedValue([mockPhotos[0]]);

    render(<PhotoGrid folder="vacation" />);
    await screen.findByAltText("beach.jpg");
    expect(mockListPhotos).toHaveBeenCalledTimes(1);

    // The final refresh event (status !== "running") must trigger a reload so
    // tiles pick up regenerated thumbnails and metadata.
    await act(async () => {
      hoisted.refreshListener?.({
        payload: { total: 2, done: 2, failed: 0, status: "done" },
      });
    });
    await waitFor(() => expect(mockListPhotos).toHaveBeenCalledTimes(2));

    // Per-photo "running" events must not hammer the backend.
    await act(async () => {
      hoisted.refreshListener?.({
        payload: { total: 2, done: 1, failed: 0, status: "running" },
      });
    });
    expect(mockListPhotos).toHaveBeenCalledTimes(2);
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

  describe("keyboard navigation", () => {
    // Three completed tiles, sorted by name so the on-screen order is a, b, c.
    const navPhotos: Photo[] = ["a", "b", "c"].map((n) =>
      makePhoto({
        id: n,
        filename: `${n}.jpg`,
        s3Key: `vacation/${n}.jpg`,
        folder: "vacation",
      })
    );
    const tile = (id: string) =>
      document.querySelector<HTMLElement>(`[data-nav-id="${id}"]`);
    // The keyboard cursor is the tile's own DOM focus (highlighted via
    // :focus-visible in globals.css).
    const isFocused = (id: string) => document.activeElement === tile(id);

    async function renderNavGrid() {
      mockListPhotos.mockResolvedValueOnce(navPhotos);
      const view = render(<PhotoGrid folder="vacation" sortMode="name-asc" />);
      await screen.findByAltText("a.jpg");
      return view;
    }

    it("moves the focus cursor with the arrow keys and opens with Enter", async () => {
      await renderNavGrid();

      // First arrow press seats the cursor on the first tile.
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect(isFocused("a")).toBe(true);

      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect(isFocused("a")).toBe(false);
      expect(isFocused("b")).toBe(true);

      fireEvent.keyDown(document.body, { key: "ArrowLeft" });
      expect(isFocused("a")).toBe(true);

      // Enter opens the focused tile in the lightbox.
      fireEvent.keyDown(document.body, { key: "Enter" });
      expect(screen.getByTestId("lightbox-filename")).toHaveTextContent("a.jpg");
    });

    it("navigates with vim hjkl", async () => {
      await renderNavGrid();

      fireEvent.keyDown(document.body, { key: "l" });
      expect(isFocused("a")).toBe(true);
      fireEvent.keyDown(document.body, { key: "l" });
      expect(isFocused("b")).toBe(true);
      fireEvent.keyDown(document.body, { key: "h" });
      expect(isFocused("a")).toBe(true);
    });

    it("toggles selection of the focused tile with x", async () => {
      await renderNavGrid();

      fireEvent.keyDown(document.body, { key: "ArrowRight" }); // focus a
      fireEvent.keyDown(document.body, { key: "x" });
      expect(tile("a")).toHaveClass("border-accent");

      fireEvent.keyDown(document.body, { key: "x" });
      expect(tile("a")).not.toHaveClass("border-accent");
    });

    it("extends a range selection with Shift+arrow, growing and shrinking", async () => {
      await renderNavGrid();

      fireEvent.keyDown(document.body, { key: "ArrowRight" }); // focus a
      fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true }); // a..b
      expect(tile("a")).toHaveClass("border-accent");
      expect(tile("b")).toHaveClass("border-accent");
      expect(tile("c")).not.toHaveClass("border-accent");

      fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true }); // a..c
      expect(tile("c")).toHaveClass("border-accent");

      // Shrinking back keeps the anchor fixed at a, so c drops out.
      fireEvent.keyDown(document.body, { key: "ArrowLeft", shiftKey: true }); // a..b
      expect(tile("a")).toHaveClass("border-accent");
      expect(tile("b")).toHaveClass("border-accent");
      expect(tile("c")).not.toHaveClass("border-accent");
    });

    it("ignores grid keys while the lightbox is open", async () => {
      await renderNavGrid();

      fireEvent.dblClick(screen.getByAltText("a.jpg"));
      expect(screen.getByTestId("lightbox")).toBeInTheDocument();

      // The lightbox owns the keyboard now — x must not reach the grid.
      fireEvent.keyDown(document.body, { key: "x" });
      expect(tile("a")).not.toHaveClass("border-accent");
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
