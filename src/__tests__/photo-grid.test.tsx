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
import { useSelection } from "@/hooks/use-selection";
import { PhotoGrid } from "@/components/photo-grid";

// The grid reads multi-select state from context, so every render needs the
// provider around it.
function render(ui: Parameters<typeof rtlRender>[0]) {
  return rtlRender(ui, { wrapper: SelectionProvider });
}
import { listPhotos, searchPhotoIds, updatePhoto } from "@/lib/api";
import type { Photo } from "@/lib/types";
import type { UploadFile } from "@/hooks/use-upload";
import { makePhoto } from "./fixtures";

vi.mock("@/lib/api", () => ({
  listPhotos: vi.fn(),
  searchPhotoIds: vi.fn(),
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
    onTagsChange,
    onRename,
    onClose,
  }: {
    photo: Photo;
    onPrev?: () => void;
    onNext?: () => void;
    onTagsChange?: () => void;
    onRename?: (photo: Photo, newFilename: string) => Promise<void>;
    onClose?: () => void;
  }) => (
    <div data-testid="lightbox">
      <span data-testid="lightbox-filename">{photo.filename}</span>
      <button onClick={onPrev} disabled={!onPrev}>
        prev
      </button>
      <button onClick={onNext} disabled={!onNext}>
        next
      </button>
      <button onClick={onTagsChange}>change-tags</button>
      <button onClick={() => onRename?.(photo, "renamed.jpg")}>rename</button>
      <button onClick={onClose}>close</button>
    </div>
  ),
}));

// Stands in for the bulk tag editor so tests can assert it stays mounted while
// the user is mid-edit.
vi.mock("@/components/bulk-tag-dialog", () => ({
  BulkTagDialog: () => <div data-testid="bulk-tag-dialog" />,
}));

const mockListPhotos = vi.mocked(listPhotos);
const mockSearchIds = vi.mocked(searchPhotoIds);

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

/** A photo:// src with its `?v=` cache-buster stripped. These tests care about
 * which object a tile addresses, not the version token that forces WKWebView
 * to refetch after a replace (see resolveUrl in src/lib/image-url.ts). */
function srcPath(el: Element) {
  return el.getAttribute("src")?.split("?")[0];
}

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
    expect(srcPath(img)).toBe("photo://localhost/vacation/beach_640.webp");

    // A photo synced into the bucket externally has no variants yet — the
    // 640px request 404s and the tile must degrade to the original object
    // instead of a broken image.
    fireEvent.error(img);
    expect(srcPath(img)).toBe("photo://localhost/vacation/beach.jpg");
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
    expect(srcPath(img)).toBe("photo://localhost/vacation/beach.jpg");

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
    expect(srcPath(img)).toBe("photo://localhost/vacation/beach.jpg");

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
      expect(srcPath(screen.getByAltText("beach.jpg"))).toBe(
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
    expect(srcPath(img)).toBe("photo://localhost/calella/R0007098_640.webp");
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

  it("filters tiles via the folder-scoped search engine", async () => {
    mockListPhotos.mockResolvedValueOnce(mockPhotos);
    // The scoped typed-query engine matches only the beach photo.
    mockSearchIds.mockResolvedValue(["1"]);

    const { rerender } = render(<PhotoGrid folder="vacation" query="" />);

    await waitFor(() => {
      expect(screen.getByAltText("beach.jpg")).toBeInTheDocument();
    });

    // A query runs the scoped id search (debounced) and keeps only the matched
    // tiles; the rest animate out (presence exit).
    rerender(<PhotoGrid folder="vacation" query="beach" />);
    await waitFor(() => {
      expect(mockSearchIds).toHaveBeenCalledWith("beach", "vacation");
    });
    await waitFor(() => {
      expect(screen.queryByText("Pending...")).not.toBeInTheDocument();
    });
    expect(screen.getByAltText("beach.jpg")).toBeInTheDocument();

    // A query the engine matches nothing for shows the no-match empty state.
    mockSearchIds.mockResolvedValue([]);
    rerender(<PhotoGrid folder="vacation" query="nope" />);
    await waitFor(() => {
      expect(screen.getByText(/No photos match/)).toHaveTextContent("nope");
    });
    expect(screen.queryByAltText("beach.jpg")).not.toBeInTheDocument();
  });

  it("never claims 'no photos match' for a query it hasn't run yet", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);
    // The first query genuinely matches nothing.
    mockSearchIds.mockResolvedValueOnce([]);

    const { rerender } = render(<PhotoGrid folder="vacation" query="" />);
    await screen.findByAltText("beach.jpg");

    rerender(<PhotoGrid folder="vacation" query="zzz" />);
    await waitFor(() => {
      expect(screen.getByText(/No photos match/)).toHaveTextContent("zzz");
    });

    // Now type a different query whose search is still in flight. The stale
    // empty match set must NOT be reported as a verdict on the new text —
    // that would assert a result for a query that never ran.
    let resolveSearch!: (ids: string[]) => void;
    mockSearchIds.mockReturnValueOnce(
      new Promise((res) => {
        resolveSearch = res;
      })
    );
    rerender(<PhotoGrid folder="vacation" query="beach" />);
    await waitFor(() => expect(mockSearchIds).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/No photos match “beach”/)).toBeNull();

    // Once it settles with a real match, the photo is shown.
    await act(async () => {
      resolveSearch(["1"]);
    });
    expect(screen.getByAltText("beach.jpg")).toBeInTheDocument();
  });

  it("reports a failed search as a failure, not as an empty result", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);
    mockSearchIds.mockRejectedValueOnce("db is locked");

    const { rerender } = render(<PhotoGrid folder="vacation" query="" />);
    await screen.findByAltText("beach.jpg");

    rerender(<PhotoGrid folder="vacation" query="tag:trip" />);

    // A backend error must not masquerade as "this folder has no matches".
    await waitFor(() => {
      expect(screen.getByText("Search failed.")).toBeInTheDocument();
    });
    expect(screen.queryByText(/No photos match/)).toBeNull();
  });

  it("re-runs the folder search when the open photo's tags change", async () => {
    mockListPhotos.mockResolvedValueOnce(mockPhotos);
    // The tag query first matches the beach + pending photos.
    mockSearchIds.mockResolvedValueOnce(["1", "2"]);

    const { rerender } = render(<PhotoGrid folder="vacation" query="" />);
    await screen.findByAltText("beach.jpg");

    rerender(<PhotoGrid folder="vacation" query="tag:trip" />);
    await waitFor(() => expect(mockSearchIds).toHaveBeenCalledTimes(1));
    // Both matches are on screen (the pending one as its status tile).
    await screen.findByText("Pending...");

    // Open the beach photo and change its tags; the search re-runs and now
    // matches only beach, so the pending photo drops out of the results.
    fireEvent.dblClick(screen.getByAltText("beach.jpg"));
    mockSearchIds.mockResolvedValueOnce(["1"]);
    fireEvent.click(screen.getByText("change-tags"));

    await waitFor(() => expect(mockSearchIds).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.queryByText("Pending...")).not.toBeInTheDocument();
    });
  });

  it("re-runs the search when the folder's rows change under an active query", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);
    mockSearchIds.mockResolvedValueOnce(["1"]);

    const { rerender } = render(<PhotoGrid folder="vacation" query="" />);
    await screen.findByAltText("beach.jpg");

    rerender(<PhotoGrid folder="vacation" query="beach" />);
    await waitFor(() => expect(mockSearchIds).toHaveBeenCalledTimes(1));

    // A library refresh imports a new matching photo and touches updated_at.
    // Nothing hand-wires this path, so the search must re-run off the row set
    // itself — otherwise the new photo is filtered out against a stale id set.
    mockListPhotos.mockResolvedValueOnce([
      { ...mockPhotos[0], updatedAt: "2026-07-20T00:00:00Z" },
      makePhoto({
        id: "9",
        filename: "beach2.jpg",
        s3Key: "vacation/beach2.jpg",
        folder: "vacation",
      }),
    ]);
    mockSearchIds.mockResolvedValueOnce(["1", "9"]);
    await act(async () => {
      hoisted.refreshListener?.({
        payload: { total: 1, done: 1, failed: 0, status: "done" },
      });
    });

    await waitFor(() => expect(mockSearchIds).toHaveBeenCalledTimes(2));
    expect(await screen.findByAltText("beach2.jpg")).toBeInTheDocument();
  });

  it("keeps the lightbox open (and withholds the empty state) when a tag edit empties the results", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]); // only beach
    mockSearchIds.mockResolvedValueOnce(["1"]); // matches beach

    const { rerender } = render(<PhotoGrid folder="vacation" query="" />);
    await screen.findByAltText("beach.jpg");

    rerender(<PhotoGrid folder="vacation" query="tag:trip" />);
    await waitFor(() => expect(mockSearchIds).toHaveBeenCalledTimes(1));

    // Open the only match, then remove its tag → the search matches nothing.
    fireEvent.dblClick(screen.getByAltText("beach.jpg"));
    expect(screen.getByTestId("lightbox")).toBeInTheDocument();
    mockSearchIds.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByText("change-tags"));
    await waitFor(() => expect(mockSearchIds).toHaveBeenCalledTimes(2));

    // The lightbox stays mounted mid-interaction and the empty-state message is
    // withheld while it's open (so it can't tear down and pop back later).
    expect(screen.getByTestId("lightbox")).toBeInTheDocument();
    expect(screen.queryByText(/No photos match/)).toBeNull();

    // Closing it reveals the empty-results message.
    fireEvent.click(screen.getByText("close"));
    await waitFor(() => {
      expect(screen.getByText(/No photos match/)).toBeInTheDocument();
    });
    expect(screen.queryByTestId("lightbox")).toBeNull();
  });

  it("re-runs the search after a rename", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);
    mockSearchIds.mockResolvedValueOnce(["1"]); // matches "beach"
    // The backend bumps updated_at on every write (see photos.rs), which is
    // what tells the grid its rows changed.
    vi.mocked(updatePhoto).mockResolvedValueOnce({
      ...mockPhotos[0],
      filename: "renamed.jpg",
      updatedAt: "2026-07-20T00:00:00Z",
    });

    const { rerender } = render(<PhotoGrid folder="vacation" query="" />);
    await screen.findByAltText("beach.jpg");

    rerender(<PhotoGrid folder="vacation" query="beach" />);
    await waitFor(() => expect(mockSearchIds).toHaveBeenCalledTimes(1));

    // Rename the open photo; the search must re-run so a photo that no longer
    // matches the filename query drops out against its cached match id.
    fireEvent.dblClick(screen.getByAltText("beach.jpg"));
    mockSearchIds.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByText("rename"));
    await waitFor(() => expect(mockSearchIds).toHaveBeenCalledTimes(2));
  });

  it("keeps the bulk tag editor mounted when the search empties the results", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);
    mockSearchIds.mockResolvedValueOnce(["1"]);

    const { rerender } = render(<PhotoGrid folder="vacation" query="" />);
    await screen.findByAltText("beach.jpg");

    rerender(<PhotoGrid folder="vacation" query="tag:trip" />);
    await waitFor(() => expect(mockSearchIds).toHaveBeenCalledTimes(1));

    // Select the match and open the bulk tag editor.
    fireEvent.keyDown(document, { key: "a", metaKey: true });
    fireEvent.keyDown(document, { key: "t" });
    expect(await screen.findByTestId("bulk-tag-dialog")).toBeInTheDocument();

    // A reload now empties the results while the editor is open. Taking the
    // empty-state shortcut here would unmount the dialog mid-edit and strand
    // `tagTargets`, killing the keyboard shortcuts and popping the dialog back
    // open later.
    mockListPhotos.mockResolvedValueOnce([
      { ...mockPhotos[0], updatedAt: "2026-07-20T00:00:00Z" },
    ]);
    mockSearchIds.mockResolvedValueOnce([]);
    await act(async () => {
      hoisted.refreshListener?.({
        payload: { total: 1, done: 1, failed: 0, status: "done" },
      });
    });
    await waitFor(() => expect(mockSearchIds).toHaveBeenCalledTimes(2));

    expect(screen.getByTestId("bulk-tag-dialog")).toBeInTheDocument();
    expect(screen.queryByText(/No photos match/)).toBeNull();
  });

  it("drops hidden photos from the selection so bulk actions can't reach them", async () => {
    mockListPhotos.mockResolvedValueOnce(mockPhotos); // 3 photos
    mockSearchIds.mockResolvedValue(["1"]); // the query matches only beach

    // A probe that reports what the bulk actions would actually receive.
    function Probe() {
      const { selected } = useSelection();
      return <span data-testid="sel">{selected.map((p) => p.id).join(",")}</span>;
    }
    const { rerender } = rtlRender(
      <SelectionProvider>
        <PhotoGrid folder="vacation" query="" />
        <Probe />
      </SelectionProvider>
    );
    await screen.findByAltText("beach.jpg");

    // Select everything, then narrow the grid with a query. (Order follows the
    // grid's sort, so compare as a set.)
    fireEvent.keyDown(document, { key: "a", metaKey: true });
    const ids = () => screen.getByTestId("sel").textContent!.split(",").sort();
    expect(ids()).toEqual(["1", "2", "3"]);

    rerender(
      <SelectionProvider>
        <PhotoGrid folder="vacation" query="beach" />
        <Probe />
      </SelectionProvider>
    );

    // The two photos the search hid must leave the selection — otherwise the
    // toolbar counts photos the user can't see and Delete destroys them.
    await waitFor(() => {
      expect(ids()).toEqual(["1"]);
    });
  });

  it("warns that metadata filters need loaded info when a query uses one", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);
    mockSearchIds.mockResolvedValue(["1"]);

    const { rerender } = render(<PhotoGrid folder="vacation" query="" />);
    await screen.findByAltText("beach.jpg");

    rerender(<PhotoGrid folder="vacation" query="iso:>=800" />);
    await waitFor(() => {
      expect(
        screen.getByText(/Metadata filters only match/)
      ).toBeInTheDocument();
    });
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

  describe("selection", () => {
    // Three completed tiles, sorted by name so the on-screen order is a, b, c.
    const selPhotos: Photo[] = ["a", "b", "c"].map((n) =>
      makePhoto({
        id: n,
        filename: `${n}.jpg`,
        s3Key: `vacation/${n}.jpg`,
        folder: "vacation",
      })
    );
    const tile = (id: string) =>
      document.querySelector<HTMLElement>(`[data-nav-id="${id}"]`);
    const check = (id: string) => tile(id)?.querySelector(".badge-in") ?? null;

    async function renderSelGrid() {
      mockListPhotos.mockResolvedValueOnce(selPhotos);
      const view = render(<PhotoGrid folder="vacation" sortMode="name-asc" />);
      await screen.findByAltText("a.jpg");
      return view;
    }

    it("marks a single selection with the border alone, no corner check", async () => {
      await renderSelGrid();

      fireEvent.click(screen.getByAltText("a.jpg"));

      expect(tile("a")).toHaveClass("border-accent");
      // The badge is the multi-select cue; one photo doesn't need it.
      expect(check("a")).toBeNull();
    });

    it("shows the corner check once several photos are selected", async () => {
      await renderSelGrid();

      fireEvent.click(screen.getByAltText("a.jpg"));
      fireEvent.click(screen.getByAltText("b.jpg"), { metaKey: true });

      expect(check("a")).not.toBeNull();
      expect(check("b")).not.toBeNull();
      expect(check("c")).toBeNull();

      // Back down to one selected photo, the badges go away again.
      fireEvent.click(screen.getByAltText("b.jpg"), { metaKey: true });
      expect(tile("a")).toHaveClass("border-accent");
      expect(check("a")).toBeNull();
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

  it("keeps a replace's tile on screen while it is still working", async () => {
    // A replace targets a photo that is ALREADY "completed", unlike an import
    // whose row is "pending" until the end. Handing off on the row's status
    // alone would dismiss this tile the instant it learned its photo id —
    // at 0%, before any progress could ever be seen.
    mockListPhotos.mockResolvedValueOnce([mockPhotos[0]]);

    const onDismiss = vi.fn();
    const upload = makeUpload({ id: "1", status: "uploading", progress: 48 });
    const { container } = render(
      <PhotoGrid folder="vacation" uploads={[upload]} onDismissUpload={onDismiss} />
    );

    await waitFor(() => expect(screen.getByText("48%")).toBeInTheDocument());
    // Not dismissed, and not even preloading the handoff image yet.
    expect(onDismiss).not.toHaveBeenCalled();
    expect(container.querySelector("img.hidden")).not.toBeInTheDocument();
  });

  it("dismisses the upload when processing fails so the photo tile shows the error", async () => {
    mockListPhotos.mockResolvedValueOnce([mockPhotos[2]]);

    const onDismiss = vi.fn();
    const upload = makeUpload({ id: "3", filename: "failed.jpg", status: "error" });
    render(
      <PhotoGrid folder="vacation" uploads={[upload]} onDismissUpload={onDismiss} />
    );

    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalledWith("u1");
    });
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  // Re-dropping a file that failed retries it in place: the importer reuses
  // that same `failed` row, so the row still reads "failed" (our copy of it is
  // stale until the retry lands) while a live import is running against it.
  describe("retrying a failed import", () => {
    // The tile only learns the reused row's id once the importer reserves it.
    const retry = (overrides: Partial<UploadFile> = {}) =>
      makeUpload({
        key: "vacation/failed.jpg",
        filename: "failed.jpg",
        status: "pending",
        progress: 0,
        ...overrides,
      });

    it("keeps the retry's tile instead of dismissing it as failed", async () => {
      mockListPhotos.mockResolvedValueOnce([mockPhotos[2]]);

      const onDismiss = vi.fn();
      const upload = retry({ id: "3", status: "uploading", progress: 40 });
      render(
        <PhotoGrid
          folder="vacation"
          uploads={[upload]}
          onDismissUpload={onDismiss}
          onCancelUpload={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("40%")).toBeInTheDocument();
      });
      // The tile stays in the upload list (so the toolbar still counts it as
      // cancellable) and keeps its own Cancel button.
      expect(onDismiss).not.toHaveBeenCalled();
      expect(screen.getByText("Cancel")).toBeInTheDocument();
      // ...and the stale error tile it is replacing is gone.
      expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    });

    it("keeps the retry's tile while the finished row is still stale", async () => {
      // The importer finalizes the row to "completed" before it reports done,
      // but our copy only catches up when the batch's refresh fires — which,
      // for a multi-file drop, is after the LAST file finishes. Handing off in
      // that window would show a "Failed" tile for an upload that succeeded.
      mockListPhotos.mockResolvedValueOnce([mockPhotos[2]]);

      const onDismiss = vi.fn();
      const upload = retry({ id: "3", status: "done", progress: 100 });
      render(
        <PhotoGrid
          folder="vacation"
          uploads={[upload]}
          onDismissUpload={onDismiss}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Processing…")).toBeInTheDocument();
      });
      expect(onDismiss).not.toHaveBeenCalled();
      expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    });

    it("hides the stale failed tile before the retry knows its photo id", async () => {
      mockListPhotos.mockResolvedValueOnce([mockPhotos[2]]);

      render(<PhotoGrid folder="vacation" uploads={[retry()]} />);

      await waitFor(() => {
        expect(screen.getByText("0%")).toBeInTheDocument();
      });
      expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    });

    it("hands back to the photo tile once the retry fails again", async () => {
      mockListPhotos.mockResolvedValueOnce([mockPhotos[2]]);

      const onDismiss = vi.fn();
      const upload = retry({ id: "3", status: "error", error: "boom" });
      render(
        <PhotoGrid
          folder="vacation"
          uploads={[upload]}
          onDismissUpload={onDismiss}
        />
      );

      await waitFor(() => {
        expect(onDismiss).toHaveBeenCalledWith("vacation/failed.jpg");
      });
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });
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
